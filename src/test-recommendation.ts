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
const aiModel = process.env.AI_MODEL || "claude-sonnet-4-20250514";
const aiLanguage = process.env.AI_LANGUAGE || "en";
const baseUrl = process.env.BASE_URL || "";

// ---------------------------------------------------------------------------
// Security: sanitize secrets from error messages
// ---------------------------------------------------------------------------

function sanitizeError(message: string): string {
  let sanitized = message;
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/gi, "Bearer ***");
  sanitized = sanitized.replace(/(?:sk-|ghp_|gho_|ghs_|ghr_|sk-ant-)[A-Za-z0-9_\-]+/g, "***");
  const secrets = [githubToken, anthropicApiKey].filter(Boolean);
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
  const baseUrlGuidance = baseUrl
    ? `\n\n## GUI Verification URLs\nWhen the QA plan includes GUI verification, construct URLs using this base: \`${baseUrl}\`\nExample: \`${baseUrl}/admin/surveys\` for the surveys management page.\nInclude clickable URLs in the verification steps.`
    : "";

  return `You are a software engineer creating a quality assurance report based on Dependabot PR impact analysis results.
The reader of this report is a **reviewer deciding whether to merge this PR**.

${getLanguageInstruction()}

## What the Reviewer Needs (in priority order)

1. **Is this package necessary?** — If unnecessary, recommend removal
2. **If necessary, what should be tested?** — Test cases logically derived from the impact scope
3. **How to verify each test case?** — GUI verification with URLs and steps, or CLI/CI verification steps

## Report Structure

1. **Package Necessity** — Why this package is needed (based on the "Dependency Classification" from the impact analysis)
2. **Change Summary** — What is being updated
3. **Impact Scope** — Where the change has impact (based on the analysis results)
4. **Risk Assessment** — Quantitative rubric-based scoring
5. **QA Plan** — Test cases with concrete verification steps
6. **Assumptions** — What this QA plan relies on

## Risk Assessment Rubric

Score each of 5 axes, then sum for the overall risk level.

### Axis 1: Dependency Type
| Score | Condition |
|-------|-----------|
| 3 | Directly imported in source code (dependencies) |
| 2 | devDependencies (affects build/test) |
| 1 | Transitive dependency only (internal dep of another package) |
| 0 | Not found in dependency tree |

### Axis 2: Library Category
| Score | Condition |
|-------|-----------|
| 3 | Runtime UI library (DOM, rendering, state management) / Security library (sanitization, auth, crypto) |
| 2 | Data processing (validation, date, formatting) / API/communication (HTTP client, DB client) |
| 1 | Monitoring/logging (Sentry, DataDog, etc.) |
| 0 | Build/dev tools (webpack, rollup, terser, eslint, etc.) |

### Axis 3: Impacted Pages
| Score | Condition |
|-------|-----------|
| 3 | 10+ pages |
| 2 | 3–9 pages |
| 1 | 1–2 pages |
| 0 | 0 pages |

### Axis 4: Update Type
| Score | Condition |
|-------|-----------|
| 3 | major |
| 1 | minor |
| 0 | patch / unknown |

### Axis 5: Feature Criticality
| Score | Condition |
|-------|-----------|
| 3 | Core user-facing features (responses, auth, data entry) |
| 2 | Admin features (list, detail, CRUD) |
| 1 | Supporting features (PDF generation, CSV export, settings) |
| 0 | Dev/internal tools only |

### Overall Risk
| Total Score | Risk Level |
|-------------|------------|
| 10+ | 🔴 High |
| 5–9 | 🟡 Medium |
| 0–4 | 🟢 Low |

## QA Plan Guidelines

- All verification items MUST be logically derived from the impact scope (don't test what's not impacted, don't miss what is)
- Keep to 5 items or fewer (1–2 items is sufficient for 🟢 Low risk)
- Each item must include:
  - **Verification type**: Build check / GUI check / Functional check / Security check
  - **How to verify**: Concrete steps${baseUrl ? `\n    - For GUI checks: include the full URL (e.g., \`${baseUrl}/<route>\`) and step-by-step instructions` : "\n    - For GUI checks: include the route path and step-by-step instructions"}
    - For build checks: specify the CI job name or local command
    - For functional checks: specify the operation steps or test command
  - **Expected result**: What normal behavior looks like
- For devDependencies or transitive-only packages, impact is limited to the build pipeline — "CI passing" is sufficient for QA${baseUrlGuidance}`;
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
  return result.content[0].text;
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

  const commentsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  const comments = (await commentsRes.json()) as IssueComment[];

  const marker = "<!-- dependabot-test-recommendation -->";
  const existing = comments.find((c) => c.body.includes(marker));
  const markedBody = `${marker}\n${body}`;

  if (existing) {
    await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ body: markedBody }),
      },
    );
    console.log("Updated existing recommendation comment.");
    return;
  }

  await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ body: markedBody }),
    },
  );
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

  const userPrompt = `Below is the impact analysis result for a Dependabot library update PR:

---
${impactAnalysis}
---

Based on this analysis, create a QA report. Output ONLY the following Markdown structure (no preamble or extra explanation):

## 🧪 QA Report

### 1. Package Necessity

(Is this package needed? Based on the dependency classification, explain why it exists and what would break if removed. If it appears unnecessary, recommend removal.)

### 2. Change Summary

(Library name, its role, update type — 1–2 sentences)

### 3. Impact Scope

Based on the impact analysis:

| Scope | Range | Details |
|-------|-------|---------|
| Direct | (file count) files, (page count) pages | (list files/pages briefly, or "None") |
| Indirect | (via packages, or "None") | (indirect page count, or "None") |

(If direct impact files exist, explain their role in the project in 1–2 sentences)

### 4. Risk Assessment

| Axis | Score | Rationale |
|------|-------|-----------|
| Dependency type | ?/3 | (direct import / devDependency / transitive / not found) |
| Library category | ?/3 | (category and reasoning) |
| Impacted pages | ?/3 | (page count) |
| Update type | ?/3 | (major/minor/patch/unknown) |
| Feature criticality | ?/3 | (affected features and user impact) |
| **Total** | **?/15** | **🔴 High / 🟡 Medium / 🟢 Low** |

### 5. QA Plan

To verify the impact scope from Section 3:

| No. | Target | Type | How to Verify | Expected Result |
|-----|--------|------|---------------|-----------------|
| 1 | (derived from impact scope) | (Build/GUI/Functional/Security) | (concrete steps${baseUrl ? `, with full URLs like ${baseUrl}/<route>` : ""}) | (normal behavior) |
| ... | ... | ... | ... | ... |

(Explain in 1–2 sentences why these items provide sufficient quality assurance)

### 6. Assumptions

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
