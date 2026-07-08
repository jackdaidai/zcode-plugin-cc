# ZCode plugin for Claude Code

Use **ZCode** from inside **Claude Code** for code reviews or to delegate tasks to ZCode.

This is a port of OpenAI's [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
The Codex plugin's architecture is `{engine}-plugin-{host}`: Codex engine + Claude Code host.
This project keeps the **Claude Code host** and swaps the **engine from Codex to ZCode** — so
the slash commands become `/zcode:review`, `/zcode:rescue`, etc. The host integration (Claude
Code plugin conventions, hooks, `${CLAUDE_PLUGIN_ROOT}` tokens) is unchanged; only the engine
layer that talks to the coding agent was rewritten to speak the **ZCode Protocol**.

## What You Get

- `/zcode:review` — a read-only ZCode review of your current git state
- `/zcode:adversarial-review` — a steerable challenge review
- `/zcode:rescue`, `/zcode:transfer`, `/zcode:status`, `/zcode:result`, `/zcode:cancel` — delegate work, hand off sessions, and manage background jobs
- `/zcode:setup` — check ZCode readiness and optionally enable a stop-time review gate
- a `zcode:zcode-rescue` subagent

## Requirements

- **Claude Code** (this is a Claude Code plugin — the host)
- **ZCode CLI installed and signed in** (the engine). Verify with `zcode --version` and `zcode login`.
  - ZCode ships its own runtime; there is nothing to `npm install`.
- **Node.js 18.18 or later**

## Install (in Claude Code)

Add this marketplace in Claude Code:

```
/plugin marketplace add <your-github-user>/zcode-plugin-cc
```

Install the plugin:

```
/plugin install zcode@zcode-plugin-cc
```

Reload plugins, then run:

```
/zcode:setup
```

`/zcode:setup` reports whether ZCode is ready. If ZCode is installed but not signed in:

```
!zcode login
```

A simple first run:

```
/zcode:review --background
/zcode:status
/zcode:result
```

## Usage

### `/zcode:review`

Runs a read-only ZCode review of your current work (uncommitted changes by default; `--base <ref>`
for branch review). Supports `--wait` and `--background`.

```
/zcode:review
/zcode:review --base main
/zcode:review --background
```

### `/zcode:adversarial-review`

A **steerable** review that questions the chosen implementation and design. Same target
selection as `/zcode:review`, plus optional focus text after the flags. Read-only.

```
/zcode:adversarial-review
/zcode:adversarial-review --base main challenge whether this was the right caching design
/zcode:adversarial-review --background look for race conditions
```

### `/zcode:rescue`

Hands a task to ZCode (investigate a bug, try a fix, continue a previous task). Supports
`--background`, `--wait`, `--resume`, `--fresh`.

```
/zcode:rescue investigate why the tests started failing
/zcode:rescue --resume apply the top fix from the last run
/zcode:rescue --background investigate the regression
```

### `/zcode:transfer`

Creates a ZCode session seeded with the current Claude Code conversation and prints a
`zcode --resume <session-id>` command.

```
/zcode:transfer
/zcode:transfer --source ~/.claude/projects/<...>/<id>.jsonl
```

> Note: ZCode's app-server has no session-import RPC, so the prior Claude conversation is
> seeded as context in a new ZCode session (turn history is summarized, not replayed
> turn-by-turn). Continue it with `zcode --resume <session-id>`.

### `/zcode:status`, `/zcode:result`, `/zcode:cancel`

```
/zcode:status                 # active and recent ZCode jobs for this repo
/zcode:status task-abc123
/zcode:result                 # final stored output of a finished job
/zcode:cancel                 # cancel an active background job
```

### `/zcode:setup`

```
/zcode:setup
/zcode:setup --enable-review-gate
/zcode:setup --disable-review-gate
```

## How the engine works

The Codex original talks to `codex app-server` (a JSON-RPC server) via a long-lived broker
process. This port talks to **`zcode app-server`** the same way. The ZCode Protocol was
reverse-engineered from `zcode` 0.15.0 and differs from Codex's in three load-bearing ways:

| Concern | Codex app-server | ZCode Protocol |
|---|---|---|
| **Message framing** | JSON-RPC 2.0 (`{jsonrpc,id,method,params}`) | `{id,method,params}` — **no `jsonrpc` field** (it is rejected) |
| **Handshake** | `initialize` / `initialized` | none — ready on connect; first call is `session/create` |
| **Methods** | `thread/*`, `turn/*`, `review/*` | `session/*` (`session/create`, `session/send`, `session/read`, `session/resume`, `session/stop`, `session/list`) |

A ZCode turn is **fire-and-forget**: `session/send` returns `{accepted:true}` immediately and
the turn completes asynchronously via `state.updated` notifications until
`reason === "prompt_completed"`. The assistant text is then read from `session/read`'s
`messages[].parts[]` (`type:"text"`).

There is no native reviewer in ZCode, so `/zcode:review` collects the git diff and runs a
review as a read-only turn (the same approach the Codex plugin's adversarial review takes).

## License

Apache-2.0 (same as the upstream `openai/codex-plugin-cc`). See `LICENSE`.
