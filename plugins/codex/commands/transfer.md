---
description: Transfer the current ZCode session into a resumable Codex thread
argument-hint: "[--source <session-id|claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.

Notes on behavior:
- With no arguments, this converts the CURRENT ZCode session (read from `~/.zcode/cli/db/db.sqlite`) into a Claude-format transcript and imports it into Codex.
- With `--source <sess_...>` it converts that specific ZCode session id.
- With `--source <path-to-claude-jsonl>` it imports that Claude transcript file directly.
