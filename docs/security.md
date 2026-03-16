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

## Environment variables used by this Action

The complete list of environment variables that dependabot-insight reads is shown below. No other environment variables are accessed.

| Variable | Sensitive | Purpose |
|----------|-----------|---------|
| `GITHUB_TOKEN` | **Yes** | Post/update PR comments, fetch PR metadata |
| `ANTHROPIC_API_KEY` | **Yes** | Send QA report generation requests to Claude API |
| `BASE_URL` | **Yes** | Base URL for GUI verification links in QA reports. May contain internal URLs, so masked in logs |
| `REPOSITORY` | No | Target repository `owner/repo` (auto-set by GitHub Actions; public information) |
| `PR_NUMBER` | No | PR number to analyze |
| `DEPENDENCY_NAMES` | No | Package names being updated (comma-separated) |
| `UPDATE_TYPE` | No | Update type (`patch` / `minor` / `major` / `unknown`) |
| `AI_MODEL` | No | Claude model name to use |
| `AI_LANGUAGE` | No | Language code for QA report |
| `IMPACT_OUTPUT_PATH` | No | Temporary file path for impact analysis results (runner-local only) |
| `DRY_RUN` | No | If `true`, skip posting PR comments |

Variables marked "Sensitive" are subject to log masking and error message sanitization (details in the sections below).

## Protections for users (at Action runtime)

These protections apply when the Action runs on a Dependabot PR in the target repository.

### 1. `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / `BASE_URL` masking in logs

`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `BASE_URL` are registered with GitHub Actions' `::add-mask::` mechanism at two levels:

- **action.yml**: Registers all three values for masking before any step runs
- **Scripts**: As a defense-in-depth measure, each script (`impact-analysis.ts`, `test-recommendation.ts`) registers the same values for masking at startup

Once registered, GitHub Actions automatically replaces any occurrence of these values with `***` in all log output.

### 2. Error message sanitization

If a GitHub PR comment post or Claude API call fails, the error message may contain tokens or keys. Both scripts remove the following patterns from error messages before logging:

- `Bearer <GITHUB_TOKEN value>` → `Bearer ***`
- Anthropic API key patterns (`sk-ant-*`) → `***`
- GitHub token patterns (`ghp_*`, `gho_*`, `ghs_*`, `ghr_*`) → `***`
- Exact matches of the `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `BASE_URL` values → `***`

## Protections for contributors (when developing dependabot-insight itself)

These protections prevent contributors to the dependabot-insight repository from accidentally committing secrets.

### 3. Secret scanning with gitleaks

[gitleaks](https://github.com/gitleaks/gitleaks) is configured at two levels:

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

### FAQ

**Q. What if I don't want any data sent to Claude API?**

Omit the `anthropic-api-key` input. The Claude API will not be called, and only the static impact analysis (which stays within GitHub) will be posted as a PR comment.

**Q. What if I don't want file paths shown in PR comments?**

This is not currently supported. As an alternative, set `DRY_RUN=true` and run locally to review the results without posting them.

**Q. Are fork PR attacks (secret exfiltration) prevented?**

Yes, through two layers of protection:

- **`pull_request` event**: Secrets are not available to fork PRs (GitHub Actions behavior by design). Fork PRs cannot access `GITHUB_TOKEN` or `ANTHROPIC_API_KEY`.
- **`issue_comment` event**: Secrets are available, so this Action verifies the PR author is `dependabot[bot]` via the GitHub API and refuses to run on PRs from other authors. `dependabot[bot]` is an internally managed GitHub bot account — regular users cannot create accounts with the `[bot]` suffix, and the `author.login` value returned by the GitHub API is authenticated by GitHub, making impersonation impossible. Additionally, the trigger command (`/dep-insight`) can be restricted to `MEMBER` / `OWNER` / `COLLABORATOR` via `author_association` checks in the user's workflow (see the setup example in README).
