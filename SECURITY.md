# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

To report a security issue responsibly:

1. Open a **private security advisory** on GitHub:
   - Go to the **Security** tab of this repository
   - Click **"Report a vulnerability"** → **"New advisory"**
   - This keeps the report private to the maintainers.
2. Or, if you prefer, email the maintainer directly:
   `jackdaidai@users.noreply.github.com`

Include as much of the following as possible:

- A description of the issue and its potential impact
- Steps to reproduce (proof of concept)
- Affected versions / commit
- Any suggested fixes

## Response expectations

- **Acknowledgement:** within 72 hours.
- **Initial assessment:** within 7 days.
- **Fix or mitigation:** severity-dependent; we'll coordinate a disclosure
  timeline with you.

Please **do not** disclose the vulnerability publicly until a fix has been
released and we've agreed on a publication date.

## Scope

This policy covers the code in this repository
(`jackdaidai/zcode-plugin-cc`). It does **not** cover:

- Vulnerabilities in the ZCode runtime itself — report those to Z.ai.
- Vulnerabilities in Claude Code — report those to Anthropic.
- Vulnerabilities in the upstream `openai/codex-plugin-cc` — report those to
  OpenAI.
- Issues in a contributor's own environment or configuration.

## Supported versions

Only the latest release on the `main` branch receives security updates.

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| older   | ❌        |
