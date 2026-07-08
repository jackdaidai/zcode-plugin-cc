---
description: Transfer the current Claude Code session into a resumable ZCode session
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the ZCode session ID and the `zcode --resume <session-id>` command.
