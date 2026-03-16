# AI Model Selection

> English | [日本語](./ai-model-selection.ja.md)

This document explains the rationale for the default AI model used in dependabot-insight's QA report generation.

## Default model

`claude-sonnet-4-6` (Claude Sonnet 4.6)

## Why Sonnet?

The QA report generation task has the following characteristics:

| Characteristic | Detail |
|----------------|--------|
| **Input** | Structured Markdown (impact analysis summary with tables and lists) |
| **Output** | Structured Markdown (QA report following a fixed template) |
| **Reasoning required** | Moderate — logically derive test cases from impact scope, classify dependency type |
| **Creativity required** | Low — follow the template, produce concrete verification commands |
| **Latency sensitivity** | Low — runs asynchronously in CI, not interactive |

### Model comparison for this task

| Model | Fit | Reason |
|-------|-----|--------|
| **Claude Opus** | Over-qualified | The structured input/output and template-following nature of the task do not require Opus-level reasoning. Higher cost and latency with marginal quality improvement. |
| **Claude Sonnet** | Appropriate | Sufficient reasoning capability for dependency classification, test case derivation, and verification command generation. Good balance of quality, speed, and cost. |
| **Claude Haiku** | Risky | May produce shallow test cases or miss nuanced impact relationships. The logical derivation from impact scope to concrete test steps benefits from Sonnet's reasoning capability. |

## Overriding the default

Users can specify a different model via the `ai-model` input:

```yaml
- uses: nokki-y/dependabot-insight@v1
  with:
    ai-model: 'claude-opus-4-6'  # Use Opus for higher quality
```

Consider overriding when:
- **Use Opus**: The target repository has complex dependency relationships or security-critical packages where thorough analysis is valuable
- **Use Haiku**: Cost optimization is a priority and the target repository primarily receives low-risk patch updates
