# Testing Guide

> English | [日本語](./testing.ja.md)

This document describes how to test dependabot-insight during development.

## Prerequisites

- Node.js 22+
- npm
- A repository with Dependabot PRs (e.g., the repository where dependabot-insight will be installed)

## 1. Local script execution (DRY_RUN)

Run the analysis scripts directly against a target repository without posting PR comments.

### impact-analysis.ts

```bash
cd /path/to/target-repository

DEPENDENCY_NAMES=flatted \
UPDATE_TYPE=patch \
DRY_RUN=true \
  npx tsx /path/to/dependabot-insight/src/impact-analysis.ts
```

This will:
- Scan the target repository's source files
- Build the import graph and trace impact to pages/routes
- Print the impact summary to the console (no PR comment posted)

### test-recommendation.ts

First, run `impact-analysis.ts` with `IMPACT_OUTPUT_PATH` to save the analysis result:

```bash
cd /path/to/target-repository

DEPENDENCY_NAMES=flatted \
UPDATE_TYPE=patch \
DRY_RUN=true \
IMPACT_OUTPUT_PATH=/tmp/dependabot-impact-analysis.md \
  npx tsx /path/to/dependabot-insight/src/impact-analysis.ts
```

Then run `test-recommendation.ts` using that output:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
IMPACT_OUTPUT_PATH=/tmp/dependabot-impact-analysis.md \
AI_MODEL=claude-sonnet-4-6 \
AI_LANGUAGE=en \
DRY_RUN=true \
  npx tsx /path/to/dependabot-insight/src/test-recommendation.ts
```

This will:
- Read the impact analysis from the temporary file
- Call the Claude API to generate a QA report
- Print the QA report to the console (no PR comment posted)

### What DRY_RUN skips

| Behavior | DRY_RUN=true | Normal |
|----------|-------------|--------|
| Scan target repository | Yes | Yes |
| Build import graph | Yes | Yes |
| Call Claude API | Yes (test-recommendation.ts only) | Yes |
| Post PR comment | **No** (prints to console) | Yes |

## 2. Integration testing (branch reference)

Test the full Action pipeline (including `action.yml` orchestration) by referencing the development branch from another repository's workflow.

### Step 1: Push the development branch

```bash
cd /path/to/dependabot-insight
git push origin feature/your-branch
```

### Step 2: Create a test workflow in the target repository

Create `.github/workflows/test-dependabot-insight.yml` in the target repository:

```yaml
name: Test Dependabot Insight

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  test:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: nokki-y/dependabot-insight@feature/your-branch  # development branch
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Step 3: Trigger on a Dependabot PR

The workflow will run on any Dependabot PR in the target repository, executing the development branch version of the Action.

### What to verify

- [ ] Action completes without errors
- [ ] Impact analysis comment is posted on the PR with correct dependency classification
- [ ] QA report comment is posted (if `ANTHROPIC_API_KEY` is set)
- [ ] Affected pages/routes match expectations
- [ ] No secrets appear in the workflow logs

### Cleanup

After testing, remove the test workflow from the target repository:

```bash
git rm .github/workflows/test-dependabot-insight.yml
git commit -m "Remove dependabot-insight test workflow"
```

## 3. Type checking

Verify TypeScript types without running the scripts:

```bash
cd /path/to/dependabot-insight
npx tsc --noEmit
```
