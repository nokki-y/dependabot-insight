# dependabot-insight

Analyze the impact scope of Dependabot PRs with static analysis and generate AI-powered QA reports.

> English | [日本語](./README.ja.md)

## What it does

When Dependabot creates a PR, this action automatically:

1. **Classifies the dependency** — Is it a runtime dependency, dev dependency, or transitive (internal dependency of another package)?
2. **Traces impact to pages/routes** — Uses TypeScript AST parsing to follow the import graph from the updated package to reachable Next.js pages and API routes
3. **Analyzes indirect dependencies** — If no direct imports are found, parses `package-lock.json` to identify which project packages transitively depend on the updated package
4. **Generates a QA report with AI** — Calls the Claude API to produce a risk-scored quality assurance plan with concrete test steps

The results are posted as PR comments, giving reviewers everything they need to decide whether to merge.

### Example output

<details>
<summary>Impact Analysis Comment</summary>

> ## Impact Analysis
>
> ### Dependency Classification
>
> | Package | Classification | Description |
> |---|---|---|
> | `dompurify` | **dependencies** | Listed in package.json dependencies. Used at runtime |
>
> ### Impact Summary
>
> | Item | Value |
> |------|-------|
> | Update type | `patch` |
> | Files that directly import this package | 3 |
> | Pages impacted | 5 |
> | API routes impacted | 0 |
>
> ### Impacted Pages
>
> - `/admin/surveys/:id/edit`
> - `/admin/reports/:id`
> - ...

</details>

<details>
<summary>AI QA Report Comment</summary>

> ## QA Report
>
> ### 1. Package Necessity
> `dompurify` is a runtime dependency used for HTML sanitization. Removing it would break XSS protection.
>
> ### 2. Risk Assessment
>
> | Axis | Score | Rationale |
> |------|-------|-----------|
> | Dependency type | 3/3 | Directly imported in source code |
> | Library category | 3/3 | Security library (sanitization) |
> | Reachable pages | 2/3 | 5 pages |
> | Update type | 0/3 | patch |
> | Feature criticality | 3/3 | Core security function |
> | **Total** | **11/15** | **High** |
>
> ### 3. QA Plan
>
> | No. | Target | Method | Expected Result |
> |-----|--------|--------|-----------------|
> | 1 | Rich text editor | Open `/admin/surveys/:id/edit`, enter HTML content | Content is sanitized correctly |
> | ... | ... | ... | ... |

</details>

## Setup

### 1. Configure secrets

Go to your repository **Settings > Secrets and variables > Actions** and add:

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | API key from [Anthropic Console](https://console.anthropic.com/). Required for AI QA report generation. If omitted, only the static impact analysis is posted |

> `GITHUB_TOKEN` is automatically provided by GitHub Actions — no manual setup needed.

### 2. Create workflow file

Create `.github/workflows/dependabot-insight.yml`:

```yaml
name: Dependabot Insight

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  analyze:
    if: |
      (github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]') ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && contains(github.event.comment.body, '/dep-insight'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: nokki-y/dependabot-insight@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### With all options

```yaml
      - uses: nokki-y/dependabot-insight@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          ai-model: 'claude-sonnet-4-6'          # Claude model (default: claude-sonnet-4-6)
          ai-language: 'ja'                        # QA report language (default: en)
          base-url: 'https://my-app-pr-123.vercel.app'  # For GUI verification URLs
```

### Trigger via comment

Post `/dep-insight` as a comment on any Dependabot PR to trigger the analysis manually.

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | — | GitHub token for posting PR comments |
| `anthropic-api-key` | No | — | Anthropic API key for AI QA report generation. If omitted, only the static impact analysis is posted |
| `ai-model` | No | `claude-sonnet-4-6` | Claude model to use for QA report generation |
| `ai-language` | No | `en` | Language for the AI QA report. `en` (English) and `ja` (Japanese) have optimized prompts. Other language codes (e.g., `ko`, `zh`) are passed to Claude as-is |
| `base-url` | No | — | Base URL for GUI verification links in the QA report (e.g., Vercel preview URL) |

## How it works

```
Dependabot PR created
        │
        ▼
┌─────────────────────────┐
│  Classify dependency    │  package.json → dependencies / devDependencies / transitive
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Parse imports (AST)    │  TypeScript AST → import/require/export declarations
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Build import graph     │  file A imports B, B imports C → directed graph
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  BFS to pages/routes    │  Reverse-traverse graph → find reachable page.tsx / route.ts
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     │ No pages?   │
     └──────┬──────┘
            │ Yes
            ▼
┌─────────────────────────┐
│  Indirect dep analysis  │  package-lock.json → which root packages depend on updated pkg?
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Post impact comment    │  → PR comment with impact summary
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  AI QA report           │  Claude API → risk assessment + test plan
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Post QA comment        │  → PR comment with QA report
└─────────────────────────┘
```

## Prerequisites

- **npm** — Parses `package-lock.json` for transitive dependency analysis. yarn and pnpm are not yet supported.
- **Next.js App Router** — Traces impact to `page.tsx` / `route.ts` files using App Router conventions.

### Next.js App Router support

- Detects `page.tsx` / `page.ts` as pages
- Detects `route.ts` in `app/api/` as API routes
- Resolves `tsconfig.json` path aliases
- Handles Route Groups `(group)`, Dynamic Segments `[id]`, Catch-all `[...slug]`

> Support for other package managers (yarn, pnpm) and frameworks (Pages Router, Remix, SvelteKit, etc.) is planned for future releases.

## Security

See [docs/security.md](./docs/security.md) for the full security design document, including:

- Data flow diagram — what is sent to GitHub API and Claude API
- Built-in protections (secret masking, error sanitization, gitleaks)
- Considerations for private repositories

## Development

```bash
git clone https://github.com/nokki-y/dependabot-insight.git
cd dependabot-insight
npm install
```

### Secret scanning

This repository uses [gitleaks](https://github.com/gitleaks/gitleaks) to prevent accidental secret commits:

- **CI**: Runs automatically on every push and pull request (`.github/workflows/gitleaks.yml`)
- **Local**: Install [pre-commit](https://pre-commit.com/) and run `pre-commit install` to enable the local hook

### Running locally

Copy the environment template and fill in your values:

```bash
cp .env.example .env
# Edit .env with your credentials (never commit this file)
```

```bash
# Set environment variables
export GITHUB_TOKEN="..."
export ANTHROPIC_API_KEY="..."
export REPOSITORY="owner/repo"
export PR_NUMBER="123"
export DEPENDENCY_NAMES="package-name"
export UPDATE_TYPE="patch"
export DRY_RUN="true"

# Run impact analysis
npx tsx src/impact-analysis.ts

# Run AI QA report
npx tsx src/test-recommendation.ts
```

## License

MIT
