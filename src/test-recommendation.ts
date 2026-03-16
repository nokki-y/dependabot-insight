/**
 * Dependabot PR AI-Powered QA Report Generator
 *
 * Takes the impact analysis result and generates a quality assurance
 * report with risk assessment and concrete test plans using Claude API.
 */
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
const impactAnalysisPath = process.env.IMPACT_OUTPUT_PATH ?? "/tmp/dependabot-impact-analysis.md";
const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";
const githubToken = process.env.GITHUB_TOKEN ?? "";
const repository = process.env.REPOSITORY ?? "";
const prNumber = Number(process.env.PR_NUMBER ?? "0");
const dryRun = process.env.DRY_RUN === "true";
const aiModel = process.env.AI_MODEL || "claude-sonnet-4-6";
const aiLanguage = process.env.AI_LANGUAGE || "en";
const baseUrl = process.env.BASE_URL || "";

// ---------------------------------------------------------------------------
// Security: sanitize secrets from error messages
// ---------------------------------------------------------------------------

function sanitizeError(message: string): string {
  let sanitized = message;
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/gi, "Bearer ***");
  sanitized = sanitized.replace(/(?:sk-|ghp_|gho_|ghs_|ghr_|sk-ant-)[A-Za-z0-9_\-]+/g, "***");
  const secrets = [githubToken, anthropicApiKey, baseUrl].filter(Boolean);
  for (const secret of secrets) {
    if (secret.length > 8) {
      sanitized = sanitized.replaceAll(secret, "***");
    }
  }
  return sanitized;
}

// Mask secrets at startup so GitHub Actions redacts them from all log output
if (anthropicApiKey) {
  console.log(`::add-mask::${anthropicApiKey}`);
}
if (githubToken) {
  console.log(`::add-mask::${githubToken}`);
}
if (baseUrl) {
  console.log(`::add-mask::${baseUrl}`);
}

// ---------------------------------------------------------------------------
// Language configuration
// ---------------------------------------------------------------------------
const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en: "Write the entire report in English.",
  ja: "レポート全体を日本語で記述してください。",
};

function getLanguageInstruction(): string {
  return LANGUAGE_INSTRUCTIONS[aiLanguage] ?? `Write the entire report in the language identified by the code: "${aiLanguage}".`;
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------
function buildSystemPrompt(): string {
  const baseUrlInstruction = baseUrl
    ? `For GUI checks, construct URLs using this base: \`${baseUrl}\` (e.g., \`${baseUrl}/dashboard\`).`
    : `For GUI checks, use \`<pr-preview-url>/<route-path>\` as the URL format (the reviewer will substitute their own preview URL).`;

  return `You are a software engineer creating a quality assurance report based on Dependabot PR impact analysis results.
The reader of this report is a **reviewer deciding whether to merge this PR**.

${getLanguageInstruction()}

## What the Reviewer Needs (in priority order)

1. **Is this package necessary?** — If unnecessary, recommend removal
2. **If necessary, what should be tested?** — Test cases logically derived from the impact scope
3. **How to verify each test case?** — GUI verification with URLs and steps, or CLI/CI verification steps

## IMPORTANT: The reviewer will verify this report

The reviewer does not blindly trust AI output. For each judgment in the report (package necessity, impact scope, etc.), you MUST include verification commands that the reviewer can run themselves to confirm.

## Report Structure

1. **Package Necessity** — Why this package is needed (based on the "Dependency Classification" from the impact analysis), with verification commands
2. **Change Summary** — What is being updated
3. **Impact Scope** — Where the change has impact (based on the analysis results)
4. **QA Plan** — Test cases with concrete verification steps
5. **Assumptions** — What this QA plan relies on

## QA Plan Guidelines

- All verification items MUST be logically derived from the impact scope (don't test what's not impacted, don't miss what is)
- Keep to 5 items or fewer (1–2 items is sufficient when impact scope is limited)
- Each item must include:
  - **Verification type**: Build check / GUI check / Functional check / Security check
  - **How to verify**: Concrete steps
    - ${baseUrlInstruction}
    - For build checks: specify the CI job name or local command
    - For functional checks: specify the operation steps or test command
  - **Expected result**: What normal behavior looks like
- For devDependencies or transitive-only packages, impact is limited to the build pipeline — "CI passing" is sufficient for QA`;
}

async function callClaude(userMessage: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: aiModel,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(sanitizeError(`Anthropic API error ${response.status}: ${text}`));
  }

  const result = (await response.json()) as {
    content: { type: string; text: string }[];
  };
  const textBlock = result.content?.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("Anthropic API returned no text content in the response");
  }
  return textBlock.text;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
async function upsertComment(
  owner: string,
  repoName: string,
  issueNumber: number,
  body: string,
) {
  type IssueComment = { id: number; body: string };

  const ghHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
  };

  const commentsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments?per_page=100`,
    { headers: ghHeaders },
  );
  if (!commentsRes.ok) {
    const text = await commentsRes.text();
    throw new Error(sanitizeError(`GitHub API error ${commentsRes.status}: ${text}`));
  }
  const comments = (await commentsRes.json()) as IssueComment[];

  const marker = "<!-- dependabot-test-recommendation -->";
  const existing = comments.find((c) => c.body.includes(marker));
  const markedBody = `${marker}\n${body}`;

  if (existing) {
    const patchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${existing.id}`,
      { method: "PATCH", headers: ghHeaders, body: JSON.stringify({ body: markedBody }) },
    );
    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(sanitizeError(`GitHub API error ${patchRes.status}: ${text}`));
    }
    console.log("Updated existing recommendation comment.");
    return;
  }

  const postRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
    { method: "POST", headers: ghHeaders, body: JSON.stringify({ body: markedBody }) },
  );
  if (!postRes.ok) {
    const text = await postRes.text();
    throw new Error(sanitizeError(`GitHub API error ${postRes.status}: ${text}`));
  }
  console.log("Created new recommendation comment.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(60));
  console.log("AI QA Report Generation");
  console.log("=".repeat(60));
  console.log(`  Model: ${aiModel}`);
  console.log(`  Language: ${aiLanguage}`);
  console.log(`  Base URL: ${baseUrl || "(not set)"}`);
  console.log("");

  if (!fs.existsSync(impactAnalysisPath)) {
    console.error(`Impact analysis file not found: ${impactAnalysisPath}`);
    process.exit(1);
  }

  const impactAnalysis = fs.readFileSync(impactAnalysisPath, "utf8");
  console.log(`  Impact analysis file: ${impactAnalysisPath}`);
  console.log("");

  if (!anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Skipping AI recommendation.");
    process.exit(0);
  }

  const baseUrlPlaceholder = baseUrl || "<pr-preview-url>";

  const userPrompt = `Below is the impact analysis result for a Dependabot library update PR:

---
${impactAnalysis}
---

Based on this analysis, create a QA report.${baseUrl ? "" : ` Use \`<pr-preview-url>\` as the base URL placeholder for GUI verification (the reviewer will substitute their own preview URL).`}
Output ONLY the following Markdown structure (no preamble or extra explanation):

## 🧪 QA Report

### 1. Package Necessity

(Based on the "Dependency Classification" from the impact analysis, explain why this package is needed and what would break if removed.
- dependencies → needed at runtime
- devDependencies → needed for build/development
- transitive → name the packages that depend on it; removing it would break them
- not found → recommend cleanup with npm prune or regenerating package-lock.json
If it appears unnecessary, recommend removal.)

**Verification:**

(Include 1–2 commands the reviewer can run to verify the above judgment. Choose the most appropriate for the dependency type:

- For dependencies / devDependencies:
  \`\`\`bash
  cat package.json | grep "package-name"
  grep -r "package-name" src/ --include="*.ts" --include="*.tsx" -l
  \`\`\`

- For transitive:
  \`\`\`bash
  npm ls package-name
  \`\`\`

- For not found:
  \`\`\`bash
  npm ls package-name
  npm prune
  \`\`\`

Replace "package-name" with the actual package name.)

### 2. Change Summary

(Library name, its role, update type — 1–2 sentences)

### 3. Impact Scope

Based on the impact analysis:

| Scope | Range | Details |
|-------|-------|---------|
| Direct import | (file count) files, (page count) pages | (list files/pages briefly, or "None") |
| Via other packages | (via package names, or "None") | (page count via those packages, or "None") |

(If direct import files exist, explain their role in the project in 1–2 sentences)

### 4. QA Plan

To verify the impact scope from Section 3:

| No. | Target | Type | How to Verify | Expected Result |
|-----|--------|------|---------------|-----------------|
| 1 | (derived from impact scope) | (Build/GUI/Functional/Security) | (concrete steps. For GUI: \`${baseUrlPlaceholder}/<route>\` with operation steps. For build: CI job name or command) | (normal behavior) |
| ... | ... | ... | ... | ... |

(Explain in 1–2 sentences why these items provide sufficient quality assurance. Keep to 5 items or fewer)

### 5. Assumptions

(1–3 bullet points of assumptions this QA plan relies on)`;

  // Log what will be sent to Claude API for transparency
  console.log("  Data sent to Claude API:");
  console.log("  - Impact analysis summary (package names, route paths, file counts)");
  console.log("  - NO source code content is sent");
  console.log("  - NO tokens or credentials are sent");
  console.log("");
  console.log("  Calling Claude API...");
  const recommendation = await callClaude(userPrompt);
  console.log("  QA report generated.");
  console.log("");

  if (dryRun) {
    console.log("=".repeat(60));
    console.log("Generated QA Report:");
    console.log("=".repeat(60));
    console.log(recommendation);
    console.log("");
    console.log("[DRY_RUN] Skipped posting to GitHub.");
    return;
  }

  if (!repository || !prNumber || !githubToken) {
    throw new Error(
      "REPOSITORY, PR_NUMBER, and GITHUB_TOKEN are required for posting comments.",
    );
  }

  const [owner, repoName] = repository.split("/");
  await upsertComment(owner, repoName, prNumber, recommendation);
  console.log(`QA report posted to ${repository}#${prNumber}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(sanitizeError(message));
  process.exit(1);
});
