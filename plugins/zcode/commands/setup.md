---
description: Check whether the local ZCode CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" setup --json $ARGUMENTS
```

ZCode ships its own runtime, so this command does NOT offer to install anything. Present the
setup output to the user as-is.

Output rules:
- Present the final setup output to the user.
- If ZCode is available but not authenticated, preserve the guidance to run `!zcode login`.
- If the report lists next steps, surface them verbatim.
