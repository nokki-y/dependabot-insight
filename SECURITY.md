# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in dependabot-insight, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to report

1. Go to the [Security Advisories](https://github.com/nokki-y/dependabot-insight/security/advisories) page
2. Click "Report a vulnerability"
3. Provide a detailed description of the vulnerability

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response

This project is maintained on a best-effort basis. We will do our best to respond to security reports promptly, but cannot guarantee specific timelines.

### Scope

The following are in scope for security reports:

- Secret leakage (API keys, tokens appearing in logs or comments)
- Unauthorized code execution via crafted PRs
- Data sent to external APIs beyond what is documented in [docs/security.md](./docs/security.md)
- Bypass of Dependabot author verification

The following are out of scope:

- Issues in third-party dependencies (report to the upstream project)
- Denial of service via GitHub Actions resource consumption
