/**
 * Dependabot PR Impact Analysis Script
 *
 * Identifies files that use the updated package, traces the import graph
 * to reachable Next.js App Router pages/routes, and posts a PR comment.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Graph = Map<string, Set<string>>;

/** Indirect dependency impact info */
interface IndirectImpact {
  /** Root project package that transitively depends on the target */
  pkg: string;
  /** Files that import this package */
  files: string[];
  /** Reachable page routes */
  pageRoutes: string[];
  /** Reachable API routes */
  apiRoutes: string[];
}

/** Dependency classification */
type DependencyClassification =
  | { type: "dependencies" }
  | { type: "devDependencies" }
  | { type: "transitive"; dependedBy: string[] }
  | { type: "not-found" };

// ---------------------------------------------------------------------------
// Constants & environment variables
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");

/** Directories to exclude from scanning */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-dev",
  ".claude",
  ".git",
  "docs",
  "specs",
  "terraform",
  "public",
  "migrations",
  "schemas",
]);

/** File patterns to exclude from scanning */
const EXCLUDED_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /\.d\.ts$/,
  /\.stories\.(ts|tsx)$/,
];

/** Test-related directories to exclude */
const EXCLUDED_PATHS = [
  path.join(SRC_DIR, "test-utils"),
  path.join(SRC_DIR, "test"),
  path.join(SRC_DIR, "styles"),
];

// ---------------------------------------------------------------------------
// Security: sanitize secrets from error messages
// ---------------------------------------------------------------------------

/** Remove tokens/keys from error messages to prevent leakage in logs */
function sanitizeError(message: string): string {
  let sanitized = message;
  // Mask Authorization header values
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/gi, "Bearer ***");
  // Mask common API key patterns
  sanitized = sanitized.replace(/(?:sk-|ghp_|gho_|ghs_|ghr_|sk-ant-)[A-Za-z0-9_\-]+/g, "***");
  // Mask env var values if they appear in error messages
  const secrets = [process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.BASE_URL].filter(Boolean);
  for (const secret of secrets) {
    if (secret && secret.length > 8) {
      sanitized = sanitized.replaceAll(secret, "***");
    }
  }
  return sanitized;
}

// Mask secrets at startup so GitHub Actions redacts them from all log output
if (process.env.GITHUB_TOKEN) {
  console.log(`::add-mask::${process.env.GITHUB_TOKEN}`);
}
if (process.env.ANTHROPIC_API_KEY) {
  console.log(`::add-mask::${process.env.ANTHROPIC_API_KEY}`);
}
if (process.env.BASE_URL) {
  console.log(`::add-mask::${process.env.BASE_URL}`);
}

const dependencyNames = (process.env.DEPENDENCY_NAMES ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const repo = process.env.REPOSITORY ?? "";
const prNumber = Number(process.env.PR_NUMBER ?? "0");
const githubToken = process.env.GITHUB_TOKEN ?? "";
const updateType = process.env.UPDATE_TYPE ?? "unknown";
const dryRun = process.env.DRY_RUN === "true";

if (dependencyNames.length === 0) {
  console.error("DEPENDENCY_NAMES is empty — nothing to analyze.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// tsconfig.json path alias resolution
// ---------------------------------------------------------------------------

interface PathAlias {
  prefix: string;
  replacement: string;
}

function loadPathAliases(): PathAlias[] {
  const tsconfigPath = path.join(ROOT, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return [];

  try {
    const content = fs.readFileSync(tsconfigPath, "utf8");
    // Strip comments (tsconfig allows them)
    const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const tsconfig = JSON.parse(stripped);

    const paths: Record<string, string[]> = tsconfig.compilerOptions?.paths ?? {};
    const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
    const baseDir = path.resolve(ROOT, baseUrl);

    const aliases: PathAlias[] = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      if (targets.length === 0) continue;
      // Convert "alias/*" → "alias/" prefix, "target/*" → resolved dir
      const prefix = pattern.replace(/\*$/, "");
      const target = targets[0].replace(/\*$/, "");
      aliases.push({
        prefix,
        replacement: path.resolve(baseDir, target) + (target.endsWith("/") ? "" : "/"),
      });
    }

    return aliases;
  } catch {
    console.warn("Warning: Failed to parse tsconfig.json paths");
    return [];
  }
}

const PATH_ALIASES = loadPathAliases();

// ---------------------------------------------------------------------------
// Filesystem utilities
// ---------------------------------------------------------------------------

function isExcludedPath(filePath: string): boolean {
  return EXCLUDED_PATHS.some((excluded) => filePath.startsWith(excluded));
}

function isExcludedFile(fileName: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (isExcludedPath(full)) continue;
      files.push(...walk(full));
      continue;
    }

    if (
      entry.isFile() &&
      /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
      !isExcludedFile(entry.name)
    ) {
      files.push(full);
    }
  }

  return files;
}

function normalizeFilePath(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function isPageFile(filePath: string): boolean {
  const rel = normalizeFilePath(filePath);
  return /^src\/app\/.+\/page\.(tsx|ts|jsx|js)$/.test(rel) ||
    /^src\/app\/page\.(tsx|ts|jsx|js)$/.test(rel);
}

function isRouteHandler(filePath: string): boolean {
  const rel = normalizeFilePath(filePath);
  return /^src\/app\/api\/.+\/route\.(ts|js)$/.test(rel);
}

function fileExistsWithExtensions(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function resolveAliasImport(specifier: string): string | null {
  for (const alias of PATH_ALIASES) {
    if (specifier.startsWith(alias.prefix)) {
      const rest = specifier.slice(alias.prefix.length);
      const abs = path.join(alias.replacement, rest);
      return fileExistsWithExtensions(abs);
    }
  }
  return null;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const aliasResolved = resolveAliasImport(specifier);
  if (aliasResolved) return aliasResolved;

  if (specifier.startsWith(".")) {
    const abs = path.resolve(path.dirname(fromFile), specifier);
    return fileExistsWithExtensions(abs);
  }

  return null;
}

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, "utf8");
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function collectImports(filePath: string): {
  internal: string[];
  external: string[];
} {
  const source = parseSourceFile(filePath);
  const internal: string[] = [];
  const external: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const resolved = resolveImport(filePath, spec);
      if (resolved) {
        internal.push(resolved);
      } else if (!spec.startsWith(".") && !resolveAliasImport(spec)) {
        external.push(spec);
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const spec = node.arguments[0].text;
      const resolved = resolveImport(filePath, spec);
      if (resolved) {
        internal.push(resolved);
      } else if (!spec.startsWith(".") && !resolveAliasImport(spec)) {
        external.push(spec);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const spec = node.arguments[0].text;
      const resolved = resolveImport(filePath, spec);
      if (resolved) {
        internal.push(resolved);
      } else if (!spec.startsWith(".") && !resolveAliasImport(spec)) {
        external.push(spec);
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const resolved = resolveImport(filePath, spec);
      if (resolved) {
        internal.push(resolved);
      } else if (!spec.startsWith(".") && !resolveAliasImport(spec)) {
        external.push(spec);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  return {
    internal: [...new Set(internal)],
    external: [...new Set(external)],
  };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function buildGraphs(files: string[]) {
  const importGraph: Graph = new Map();
  const reverseGraph: Graph = new Map();
  const fileToPackages = new Map<string, string[]>();

  for (const file of files) {
    try {
      const { internal, external } = collectImports(file);
      importGraph.set(file, new Set(internal));
      fileToPackages.set(file, external);

      for (const child of internal) {
        if (!reverseGraph.has(child)) reverseGraph.set(child, new Set());
        reverseGraph.get(child)!.add(file);
      }
    } catch {
      console.warn(`Warning: Failed to parse ${normalizeFilePath(file)}`);
    }
  }

  return { importGraph, reverseGraph, fileToPackages };
}

// ---------------------------------------------------------------------------
// Indirect dependency analysis
// ---------------------------------------------------------------------------

function extractPackageName(pkgPath: string): string | null {
  const match = pkgPath.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)$/);
  return match ? match[1] : null;
}

function findIndirectDependents(targetPkgs: string[]): string[] {
  const lockfilePath = path.join(ROOT, "package-lock.json");
  if (!fs.existsSync(lockfilePath)) return [];

  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  const packages: Record<string, Record<string, unknown>> = lockfile.packages ?? {};

  const rootPkg = packages[""] ?? {};
  const rootDeps = new Set([
    ...Object.keys((rootPkg.dependencies ?? {}) as Record<string, string>),
    ...Object.keys((rootPkg.devDependencies ?? {}) as Record<string, string>),
  ]);

  const reverseDepGraph = new Map<string, Set<string>>();

  for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
    if (pkgPath === "") continue;

    const name = extractPackageName(pkgPath);
    if (!name) continue;

    const deps: Record<string, string> = {
      ...((pkgInfo.dependencies ?? {}) as Record<string, string>),
      ...((pkgInfo.peerDependencies ?? {}) as Record<string, string>),
      ...((pkgInfo.optionalDependencies ?? {}) as Record<string, string>),
    };

    for (const depName of Object.keys(deps)) {
      if (!reverseDepGraph.has(depName)) reverseDepGraph.set(depName, new Set());
      reverseDepGraph.get(depName)!.add(name);
    }
  }

  const visited = new Set<string>(targetPkgs);
  const queue = [...targetPkgs];
  const reachableRootDeps = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const parent of reverseDepGraph.get(current) ?? []) {
      if (visited.has(parent)) continue;
      visited.add(parent);

      if (rootDeps.has(parent)) {
        reachableRootDeps.add(parent);
      } else {
        queue.push(parent);
      }
    }
  }

  for (const t of targetPkgs) reachableRootDeps.delete(t);

  return [...reachableRootDeps].sort();
}

// ---------------------------------------------------------------------------
// Dependency classification
// ---------------------------------------------------------------------------

function classifyDependency(pkgName: string): DependencyClassification {
  const pkgJsonPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return { type: "not-found" };

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const deps: Record<string, string> = pkgJson.dependencies ?? {};
  const devDeps: Record<string, string> = pkgJson.devDependencies ?? {};

  if (pkgName in deps) return { type: "dependencies" };
  if (pkgName in devDeps) return { type: "devDependencies" };

  const dependedBy = findIndirectDependents([pkgName]);
  if (dependedBy.length > 0) return { type: "transitive", dependedBy };

  return { type: "not-found" };
}

// ---------------------------------------------------------------------------
// Impact tracing
// ---------------------------------------------------------------------------

function matchesDependency(specifier: string, deps: string[]): boolean {
  return deps.some(
    (dep) => specifier === dep || specifier.startsWith(`${dep}/`),
  );
}

function findImpactedFiles(
  fileToPackages: Map<string, string[]>,
  deps: string[],
): string[] {
  const impacted: string[] = [];
  for (const [file, packages] of fileToPackages.entries()) {
    if (packages.some((pkg) => matchesDependency(pkg, deps))) {
      impacted.push(file);
    }
  }
  return impacted;
}

type BfsTrace = {
  perFile: Map<string, {
    visitedCount: number;
    reachedPages: string[];
    reachedRoutes: string[];
    shortestChain: string[] | null;
    deadEndReason: string | null;
  }>;
};

function bfsReachablePages(
  startFiles: string[],
  reverseGraph: Graph,
): { pages: string[]; routes: string[]; trace: BfsTrace } {
  const allPages = new Set<string>();
  const allRoutes = new Set<string>();
  const perFile = new Map<string, {
    visitedCount: number;
    reachedPages: string[];
    reachedRoutes: string[];
    shortestChain: string[] | null;
    deadEndReason: string | null;
  }>();

  for (const startFile of startFiles) {
    const queue = [startFile];
    const visited = new Set<string>([startFile]);
    const parentMap = new Map<string, string | null>([[startFile, null]]);
    const pages = new Set<string>();
    const routes = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (isPageFile(current)) pages.add(current);
      if (isRouteHandler(current)) routes.add(current);

      for (const parent of reverseGraph.get(current) ?? []) {
        if (!visited.has(parent)) {
          visited.add(parent);
          parentMap.set(parent, current);
          queue.push(parent);
        }
      }
    }

    let shortestChain: string[] | null = null;
    const targets = [...pages, ...routes];
    for (const target of targets) {
      const chain: string[] = [target];
      let cursor: string | null | undefined = target;
      while (cursor != null && cursor !== startFile) {
        cursor = parentMap.get(cursor) ?? null;
        if (cursor != null) chain.push(cursor);
      }
      if (cursor === startFile) {
        chain.push(startFile);
        const resolved = chain.reverse();
        if (!shortestChain || resolved.length < shortestChain.length) {
          shortestChain = resolved;
        }
      }
    }

    let deadEndReason: string | null = null;
    if (pages.size === 0 && routes.size === 0) {
      const parents = reverseGraph.get(startFile);
      if (!parents || parents.size === 0) {
        deadEndReason = "No files import this file (entry point or orphan)";
      } else {
        const leafNodes = [...visited].filter((v) => {
          const ps = reverseGraph.get(v);
          return !ps || ps.size === 0 || [...ps].every((p) => visited.has(p));
        });
        const leafDisplay = leafNodes
          .filter((n) => n !== startFile)
          .slice(0, 3)
          .map((n) => normalizeFilePath(n));
        deadEndReason =
          `Traversed ${visited.size} files but could not reach page.tsx / route.ts` +
          (leafDisplay.length > 0 ? ` (leaf nodes: ${leafDisplay.join(", ")})` : "");
      }
    }

    for (const p of pages) allPages.add(p);
    for (const r of routes) allRoutes.add(r);
    perFile.set(startFile, {
      visitedCount: visited.size,
      reachedPages: [...pages],
      reachedRoutes: [...routes],
      shortestChain,
      deadEndReason,
    });
  }

  return {
    pages: [...allPages],
    routes: [...allRoutes],
    trace: { perFile },
  };
}

// ---------------------------------------------------------------------------
// Route conversion
// ---------------------------------------------------------------------------

function appPageFileToRoute(pageFile: string): string {
  const rel = normalizeFilePath(pageFile);
  const noPrefix = rel.replace(/^src\/app/, "");
  const noPage = noPrefix.replace(/\/page\.(tsx|ts|jsx|js)$/, "");

  const route = noPage
    .split("/")
    .filter(Boolean)
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => {
      if (/^\[\.\.\..+\]$/.test(seg)) return "*";
      if (/^\[\[\.{3}.+\]\]$/.test(seg)) return "*";
      if (/^\[.+\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
      return seg;
    })
    .join("/");

  return `/${route}`.replace(/\/+/g, "/");
}

function routeHandlerToRoute(routeFile: string): string {
  const rel = normalizeFilePath(routeFile);
  const noPrefix = rel.replace(/^src\/app/, "");
  const noRoute = noPrefix.replace(/\/route\.(ts|js)$/, "");

  const route = noRoute
    .split("/")
    .filter(Boolean)
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => {
      if (/^\[\.\.\..+\]$/.test(seg)) return "*";
      if (/^\[\[\.{3}.+\]\]$/.test(seg)) return "*";
      if (/^\[.+\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
      return seg;
    })
    .join("/");

  return `/${route}`.replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function githubApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(sanitizeError(`GitHub API error ${res.status}: ${text}`));
  }

  return res.json() as Promise<T>;
}

async function upsertComment(
  owner: string,
  repoName: string,
  issueNumber: number,
  body: string,
) {
  type IssueComment = { id: number; body: string };

  const comments = await githubApi<IssueComment[]>(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments?per_page=100`,
  );

  const marker = "<!-- dependabot-impact-review -->";
  const existing = comments.find((c) => c.body.includes(marker));
  const markedBody = `${marker}\n${body}`;

  if (existing) {
    await githubApi(
      `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${existing.id}`,
      { method: "PATCH", body: JSON.stringify({ body: markedBody }) },
    );
    console.log("Updated existing comment.");
    return;
  }

  await githubApi(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
    { method: "POST", body: JSON.stringify({ body: markedBody }) },
  );
  console.log("Created new comment.");
}

// ---------------------------------------------------------------------------
// Comment builder
// ---------------------------------------------------------------------------

function classificationLabel(cls: DependencyClassification): { label: string; description: string } {
  switch (cls.type) {
    case "dependencies":
      return { label: "**dependencies**", description: "Listed in package.json dependencies. Used at runtime" };
    case "devDependencies":
      return { label: "**devDependencies**", description: "Listed in package.json devDependencies. Used only during build/development" };
    case "transitive":
      return {
        label: "**transitive**",
        description: `Not listed in package.json. Internal dependency of ${cls.dependedBy.map((v) => `\`${v}\``).join(", ")}`,
      };
    case "not-found":
      return { label: "**unknown**", description: "Not found in package.json or dependency tree" };
  }
}

function buildComment(params: {
  dependencyNames: string[];
  updateType: string;
  classifications: Map<string, DependencyClassification>;
  impactedFiles: string[];
  pageRoutes: string[];
  apiRoutes: string[];
  indirectImpacts: IndirectImpact[];
}): string {
  const { dependencyNames: deps, updateType: uType, classifications, impactedFiles, pageRoutes, apiRoutes, indirectImpacts } = params;

  const indirectPageRoutes = [...new Set(indirectImpacts.flatMap((i) => i.pageRoutes))].sort();
  const indirectApiRoutes = [...new Set(indirectImpacts.flatMap((i) => i.apiRoutes))].sort();

  const lines: string[] = [];
  lines.push("## 🔍 Dependabot Impact Analysis");
  lines.push("");

  // ----- Dependency classification -----
  lines.push("### Dependency Classification");
  lines.push("");
  lines.push("| Package | Classification | Description |");
  lines.push("|---|---|---|");
  for (const dep of deps) {
    const cls = classifications.get(dep) ?? { type: "not-found" as const };
    const { label, description } = classificationLabel(cls);
    lines.push(`| \`${dep}\` | ${label} | ${description} |`);
  }
  lines.push("");

  // ----- Impact summary -----
  lines.push("### Impact Summary");
  lines.push("");
  lines.push("| Item | Value |");
  lines.push("|------|-------|");
  lines.push(`| Update type | \`${uType}\` |`);
  lines.push(`| Files that directly import this package | ${impactedFiles.length} |`);
  lines.push(`| Pages impacted | ${pageRoutes.length} |`);
  lines.push(`| API routes impacted | ${apiRoutes.length} |`);
  if (indirectImpacts.length > 0) {
    lines.push(`| Pages impacted via other packages | ${indirectPageRoutes.length} |`);
    lines.push(`| API routes impacted via other packages | ${indirectApiRoutes.length} |`);
  }
  lines.push("");

  // ----- Files that directly import -----
  if (impactedFiles.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Files that directly import this package</summary>");
    lines.push("");
    for (const file of impactedFiles.slice(0, 50)) {
      lines.push(`- \`${normalizeFilePath(file)}\``);
    }
    if (impactedFiles.length > 50) {
      lines.push(`- ... and ${impactedFiles.length - 50} more`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // ----- Impacted pages -----
  if (pageRoutes.length > 0) {
    lines.push("### Impacted Pages");
    lines.push("");
    for (const route of pageRoutes.slice(0, 30)) {
      lines.push(`- \`${route}\``);
    }
    if (pageRoutes.length > 30) {
      lines.push(`- ... and ${pageRoutes.length - 30} more`);
    }
    lines.push("");
  }

  // ----- Impacted API routes -----
  if (apiRoutes.length > 0) {
    lines.push("### Impacted API Routes");
    lines.push("");
    for (const route of apiRoutes.slice(0, 20)) {
      lines.push(`- \`${route}\``);
    }
    if (apiRoutes.length > 20) {
      lines.push(`- ... and ${apiRoutes.length - 20} more`);
    }
    lines.push("");
  }

  // ----- No source code impact -----
  if (impactedFiles.length === 0 && indirectImpacts.length === 0) {
    lines.push("> ℹ️ **No direct source code impact detected.**");
    lines.push(">");

    const allTransitive = deps.every((d) => classifications.get(d)?.type === "transitive");
    const allDevDeps = deps.every((d) => classifications.get(d)?.type === "devDependencies");

    if (allDevDeps) {
      lines.push("> This package is only used during build/development. It does not affect runtime behavior. Quality can be verified by CI build and test passing.");
    } else if (allTransitive) {
      lines.push("> This package is an internal dependency of other npm packages (removing it would break them). Since it is not directly imported in source code, runtime impact is limited unless the package's internal behavior has changed.");
    } else {
      lines.push("> No files directly import this package, and no reachable pages were detected via indirect dependency analysis.");
    }
    lines.push("");
  }

  // ----- Indirect impact -----
  if (indirectImpacts.length > 0) {
    lines.push("### Impact via Other Packages");
    lines.push("");
    lines.push(`The following project packages internally depend on ${deps.map((v) => `\`${v}\``).join(", ")}:`);
    lines.push("");
    lines.push("| Via Package | Importing Files | Pages | API Routes |");
    lines.push("|---|---|---|---|");
    for (const impact of indirectImpacts) {
      lines.push(`| \`${impact.pkg}\` | ${impact.files.length} | ${impact.pageRoutes.length} | ${impact.apiRoutes.length} |`);
    }
    lines.push("");

    if (indirectPageRoutes.length > 0) {
      lines.push("<details>");
      lines.push("<summary>Impacted pages (via other packages)</summary>");
      lines.push("");
      for (const route of indirectPageRoutes.slice(0, 30)) {
        lines.push(`- \`${route}\``);
      }
      if (indirectPageRoutes.length > 30) {
        lines.push(`- ... and ${indirectPageRoutes.length - 30} more`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }

    if (indirectApiRoutes.length > 0) {
      lines.push("<details>");
      lines.push("<summary>Impacted API routes (via other packages)</summary>");
      lines.push("");
      for (const route of indirectApiRoutes.slice(0, 20)) {
        lines.push(`- \`${route}\``);
      }
      if (indirectApiRoutes.length > 20) {
        lines.push(`- ... and ${indirectApiRoutes.length - 20} more`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("> ⚠️ This is a static analysis estimate. Dynamic segments and runtime conditional logic are not considered.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("1. Target");
  console.log("=".repeat(60));
  console.log(`  Packages: ${dependencyNames.map((v) => `"${v}"`).join(", ")}`);
  console.log(`  Update type: ${updateType}`);
  console.log("");

  // Classify dependencies
  console.log("=".repeat(60));
  console.log("2. Dependency Classification");
  console.log("=".repeat(60));

  const classifications = new Map<string, DependencyClassification>();
  for (const dep of dependencyNames) {
    const cls = classifyDependency(dep);
    classifications.set(dep, cls);
    const { label } = classificationLabel(cls);
    console.log(`  ${dep}: ${label}`);
  }
  console.log("");

  // Scan files
  console.log("=".repeat(60));
  console.log("3. Scan Scope");
  console.log("=".repeat(60));
  console.log(`  Root: ${ROOT}`);
  console.log(`  Path aliases: ${PATH_ALIASES.map((a) => `${a.prefix} → ${normalizeFilePath(a.replacement)}`).join(", ") || "(none)"}`);
  console.log("");

  const files = walk(ROOT);
  console.log(`  Scanned: ${files.length} files`);
  console.log("");

  // Build graph and analyze
  console.log("=".repeat(60));
  console.log("4. Impact Analysis");
  console.log("=".repeat(60));

  const { reverseGraph, fileToPackages } = buildGraphs(files);

  const impactedFiles = findImpactedFiles(fileToPackages, dependencyNames);
  console.log(`  Directly importing files: ${impactedFiles.length}`);
  for (const file of impactedFiles) {
    console.log(`    - ${normalizeFilePath(file)}`);
  }
  console.log("");

  const { pages, routes, trace } = bfsReachablePages(impactedFiles, reverseGraph);

  const pageRoutes = [...new Set(pages.map(appPageFileToRoute))].sort();
  const apiRoutes = [...new Set(routes.map(routeHandlerToRoute))].sort();

  console.log("  Page reachability (per start file):");
  console.log("");
  for (const [start, info] of trace.perFile) {
    const rel = normalizeFilePath(start);
    if (info.deadEndReason) {
      console.log(`  ❌ ${rel}  (traversed ${info.visitedCount} files)`);
      console.log(`     Reason: ${info.deadEndReason}`);
    } else {
      console.log(`  ✅ ${rel}  (traversed ${info.visitedCount} files → ${info.reachedPages.length} pages, ${info.reachedRoutes.length} API routes)`);
      if (info.shortestChain) {
        console.log(`     Shortest path: ${info.shortestChain.map((f) => normalizeFilePath(f)).join(" → ")}`);
      }
    }
  }
  console.log("");

  console.log(`  Reachable pages: ${pageRoutes.length}`);
  for (const route of pageRoutes) console.log(`    - ${route}`);
  console.log(`  Reachable API routes: ${apiRoutes.length}`);
  for (const route of apiRoutes) console.log(`    - ${route}`);
  console.log("");

  // Indirect dependency analysis
  const indirectImpacts: IndirectImpact[] = [];

  if (pageRoutes.length === 0 && apiRoutes.length === 0) {
    console.log("=".repeat(60));
    console.log("4.5 Indirect Dependency Analysis");
    console.log("=".repeat(60));
    console.log("  No pages/routes reached via direct imports. Analyzing indirect dependencies...");
    console.log("");

    const indirectDeps = findIndirectDependents(dependencyNames);
    console.log(`  Indirect dependents: ${indirectDeps.length}`);
    for (const dep of indirectDeps) console.log(`    - ${dep}`);
    console.log("");

    for (const dep of indirectDeps) {
      const depFiles = findImpactedFiles(fileToPackages, [dep]);
      if (depFiles.length === 0) continue;

      const { pages: indPages, routes: indRoutes } = bfsReachablePages(depFiles, reverseGraph);
      const pRoutes = [...new Set(indPages.map(appPageFileToRoute))].sort();
      const aRoutes = [...new Set(indRoutes.map(routeHandlerToRoute))].sort();

      if (pRoutes.length > 0 || aRoutes.length > 0) {
        indirectImpacts.push({ pkg: dep, files: depFiles, pageRoutes: pRoutes, apiRoutes: aRoutes });
        console.log(`  ✅ ${dep}: ${depFiles.length} files → ${pRoutes.length} pages, ${aRoutes.length} API routes`);
      } else if (depFiles.length > 0) {
        console.log(`  ❌ ${dep}: ${depFiles.length} files → no page reached`);
      }
    }
    console.log("");
  }

  // Build and post comment
  const body = buildComment({
    dependencyNames,
    updateType,
    classifications,
    impactedFiles,
    pageRoutes,
    apiRoutes,
    indirectImpacts,
  });

  const outputPath = process.env.IMPACT_OUTPUT_PATH;
  if (outputPath) {
    fs.writeFileSync(outputPath, body, "utf8");
    console.log(`  Saved analysis to ${outputPath}`);
    console.log("");
  }

  if (dryRun) {
    console.log("=".repeat(60));
    console.log("5. Generated PR Comment (DRY_RUN)");
    console.log("=".repeat(60));
    console.log(body);
    console.log("");
    console.log("[DRY_RUN] Skipped posting to GitHub.");
    return;
  }

  if (!repo || !prNumber || !githubToken) {
    throw new Error("REPOSITORY, PR_NUMBER, and GITHUB_TOKEN are required for posting comments.");
  }

  const [owner, repoName] = repo.split("/");
  await upsertComment(owner, repoName, prNumber, body);
  console.log(`Comment posted to ${repo}#${prNumber}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(sanitizeError(message));
  process.exit(1);
});
