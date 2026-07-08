---
description: Cancel an active background ZCode job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" cancel "$ARGUMENTS"`
