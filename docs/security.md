# Security Design

> English | [日本語](./security.ja.md)

This document describes the security architecture of dependabot-insight — what data flows where, what protections are in place, and what to consider when using this action in private repositories.

## Terminology

- **Target repository**: The repository where dependabot-insight is installed and Dependabot PRs are analyzed (i.e., the repository that adds this action to its workflow).

## Data flow

```
┌──────────────────────────────────────────────────────────┐
│  Target Repository (where this action is used)           │
│                                                          │
│  Files read and their purpose:                           │
│  - package.json       ... classify dependency            │
│                          (dependencies / devDependencies) │
│  - package-lock.json  ... trace transitive dependencies  │
│  - tsconfig.json      ... resolve path aliases           │
│  - src/**/*.ts(x)     ... collect import/export          │
│                          declarations only               │
│                          (full file read for AST parsing  │
│                           but source code body is NOT     │
│                           included in PR comments or      │
│                           sent to Claude API)             │
└─────────────────────────┬────────────────────────────────┘
                          │
                          │ Static analysis (runs in GitHub Actions runner)
                          ▼
             ┌──────────────────────────┐
             │  Impact Analysis         │
             │                          │
             │  Extracts:               │
             │  - package names         │
             │  - file paths            │
             │  - route paths           │
             │  - file counts           │
             │                          │
             │  * Source code body is    │
             │    NOT included in PR     │
             │    comments or sent to    │
             │    Claude API             │
             └────────────┬─────────────┘
                          │
               ┌──────────┼──────────┐
               ▼                     ▼
     ┌────────────────────────┐  ┌──────────────────────────────┐
     │  GitHub PR Comment     │  │  Claude API                  │
     │                        │  │  (only when                   │
     │  Posts:                │  │   anthropic-api-key           │
     │  Static analysis       │  │   is provided)                │
     │  results as            │  │                               │
     │  PR comment            │  │  Sends:                       │
     │  (impact summary)      │  │  - impact summary             │
     │                        │  │    (same as PR comment)       │
     │                        │  │  - prompt specifying output   │
     │                        │  │    format for QA report       │
     │                        │  │                               │
     │                        │  │  Returns:                     │
     │                        │  │  - package necessity judgment │
     │                        │  │  - test cases with steps      │
     │                        │  │  (= QA report, posted as      │
     │                        │  │    PR comment)                │
     └────────────────────────┘  └──────────────────────────────┘
```

### What is posted in PR comments

The following information is included in PR comments so that the reviewer can determine which pages are affected by the package update:

- **Package names and dependency classification** — identifies the updated package and whether it is a dependency, devDependency, or transitive
- **Relative file paths** (e.g., `src/components/Button.tsx`) — identifies which files directly import the updated package
- **Route patterns** (e.g., `/admin/users/:id`) — Next.js pages reached by traversing the import graph from the affected files, indicating which screens the reviewer should verify
- **File and page counts** — conveys the scale of the impact scope

### What is sent to Claude API

Only sent when `anthropic-api-key` is provided. The exact data sent is the impact analysis summary — the same content that is posted as a PR comment. This includes:

- Package names and dependency classification
- Relative file paths
- Route patterns
- File and page counts

**Not sent:**

- Source code content (file bodies are never read for transmission)
- Environment variables or secrets
- Repository credentials
- Git history or commit messages

### What stays local (GitHub Actions runner only)

- Source code files in the target repository (read for AST parsing, but source code body is not included in PR comments or sent to Claude API)
- `package-lock.json` content in the target repository (parsed locally for dependency tree analysis)
- `tsconfig.json` content in the target repository (parsed locally for path alias resolution)
- All tokens and API keys (used only for authenticated API calls)

## Built-in protections

### 1. Secret masking in logs

All secrets are registered with GitHub Actions' `::add-mask::` mechanism at two levels:

- **action.yml**: Masks `github-token` and `anthropic-api-key` inputs before any step runs
- **Scripts**: Each script masks its secrets at startup as a defense-in-depth measure

Once masked, GitHub Actions automatically replaces any occurrence of these values with `***` in all log output.

### 2. Error message sanitization

API errors may include request/response details. Both scripts sanitize error messages before logging:

- `Bearer <token>` → `Bearer ***`
- Known key patterns (`sk-ant-*`, `ghp_*`, `gho_*`, `ghs_*`, `ghr_*`) → `***`
- Exact matches of known secret values → `***`

### 3. Secret scanning with gitleaks

[gitleaks](https://github.com/gitleaks/gitleaks) is configured at two levels to prevent accidental secret commits:

- **CI** (`.github/workflows/gitleaks.yml`): Scans every push and pull request. Covers 800+ secret patterns
- **Local** (`.pre-commit-config.yaml`): Available as a pre-commit hook. Install with `pre-commit install`

### 4. `.gitignore` and `.env.example`

- `.env` and all `.env.*` variants are gitignored
- `.env.example` provides a template with empty values — never real credentials

## Considerations for private repositories

When the target repository is private, be aware that the following information becomes visible:

### In PR comments (visible to all repo collaborators)

- Internal file paths and directory structure
- Route patterns (which may reveal feature names or internal URLs)
- Package names and dependency relationships

### Sent to Claude API (if `anthropic-api-key` is provided)

The same information listed above is sent to Anthropic's API. Per [Anthropic's API terms](https://www.anthropic.com/api-terms), API inputs are not used for model training. However, if your organization's security policy prohibits sending internal metadata to third-party APIs, omit the `anthropic-api-key` input. The static impact analysis will still be posted as a PR comment without calling the Claude API.

### Mitigation options

| Concern | Mitigation |
|---------|------------|
| Don't want any data sent to Claude API | Omit `anthropic-api-key` — only static analysis (within GitHub) is used |
| Don't want file paths in PR comments | Not currently supported. Consider running with `DRY_RUN=true` locally instead |
| Worried about fork PR attacks | The action verifies the PR author is `dependabot[bot]` before running. Fork PRs from unknown authors are rejected |
