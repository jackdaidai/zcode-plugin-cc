---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Codex
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Delegate a task to Codex through the shared companion runtime.

Raw user request:
$ARGUMENTS

> Porting note: the original Claude Code version of this command routed through a
> `codex:codex-rescue` subagent defined in `agents/codex-rescue.md`. ZCode may or may
> not auto-load plugin-contributed subagents, so this command calls the companion
> `task` runtime directly (the subagent was only a thin forwarder around that same
> call). If the `codex:codex-rescue` subagent IS available in this ZCode session
> (visible in Settings → Subagents), you may instead delegate via
> `Agent({ subagent_type: "codex:codex-rescue", ... })`.

Core constraint:
- This command hands the work to Codex and returns Codex's output verbatim.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files, monitor progress, poll `/codex:status`, or do follow-up work of your own beyond what is needed to launch the task.

Execution mode:
- If the request includes `--background`, run the companion `task` in the background (`Bash(..., run_in_background: true)`), then tell the user: "Codex task started in the background. Check `/codex:status` for progress." and stop.
- If the request includes `--wait`, run the companion `task` in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are ZCode execution flags. Do not forward them to `task` as task text.
- `--model` and `--effort` are runtime-selection flags. Forward them to the `task` call, but do not treat them as part of the natural-language task text.

Resume routing:
- If the request includes `--resume`, do not ask whether to continue. The user already chose. Pass `--resume-last` to the companion.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose. Do not pass `--resume-last`.
- Otherwise, before starting Codex, check for a resumable rescue thread from this ZCode session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume-last` to the companion `task` call.
- If the user chooses a new thread, do not add `--resume-last`.
- If the helper reports `available: false`, do not ask. Run a fresh task.

Operating rules:
- Default to a write-capable Codex run unless the user explicitly asks for read-only behavior, review, diagnosis, or research without edits.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `--model gpt-5.3-codex-spark`.
- Preserve the user's task text as-is apart from stripping the routing/execution flags above.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write $ARGUMENTS
```
(omit `--write` when the user explicitly asked for read-only/review/diagnosis/research)
- Return the command stdout verbatim, exactly as-is. Do not add commentary before or after it.

Background flow:
- Launch the task with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --write $ARGUMENTS`,
  description: "Codex rescue task",
  run_in_background: true
})
```
(omit `--write` when the user explicitly asked for read-only/review/diagnosis/research; do not also pass `--background` in the foreground path)
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Codex task started in the background. Check `/codex:status` for progress."
