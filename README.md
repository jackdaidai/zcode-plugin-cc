# Codex plugin for ZCode

Use Codex from inside ZCode for code reviews or to delegate tasks to Codex.

This is a **ZCode port** of OpenAI's [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
(originally written for Claude Code). The Codex runtime is host-agnostic, so nearly all of the
original logic carries over unchanged; only the host-integration glue (hooks, session identity,
session transfer) has been adapted to how ZCode works.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- `/codex:setup` to check readiness and optionally enable a stop-time review gate

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 22 or later** (the `/codex:transfer` command uses the built-in `node:sqlite` module, available in Node 22+; other commands work on Node 18.18+).
- **Codex CLI installed and signed in.**

## Install

ZCode recognizes the same plugin conventions Claude Code uses (`.claude-plugin/`, `commands/`,
`skills/`, `hooks/`, `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` tokens), so you install this
just like any ZCode marketplace plugin.

### From a local directory

In ZCode: **Settings → Plugin Management → Discover → `+`** → choose **local directory** → point at
this folder (`codex-plugin-zcode`). Then install the **codex** plugin from the
**codex-plugin-zcode** marketplace and reload plugins.

### From your own GitHub repo

Push this folder to a repo, then:

- **Settings → Plugin Management → Discover → `+`** → choose **GitHub repository** →
  enter `your-name/codex-plugin-zcode`.

After install, run:

```
/codex:setup
```

`/codex:setup` reports whether Codex is ready. If Codex is missing and npm is available, it can
offer to install Codex for you. If you prefer to install Codex yourself:

```bash
npm install -g @openai/codex
```

If Codex is installed but not signed in:

```bash
!codex login
```

A simple first run:

```
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work (uncommitted changes by default; `--base <ref>`
for branch review). Supports `--wait` and `--background`. Read-only.

```
/codex:review
/codex:review --base main
/codex:review --background
```

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design. Same target
selection as `/codex:review`, plus optional focus text after the flags. Read-only.

```
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions
```

### `/codex:rescue`

Hands a task to Codex (investigate a bug, try a fix, continue a previous task, take a cheaper pass
with a smaller model). Supports `--background`, `--wait`, `--resume`, `--fresh`, `--model`, and
`--effort`.

```
/codex:rescue investigate why the tests started failing
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --background investigate the regression
```

Notes:
- If you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `spark` maps to `gpt-5.3-codex-spark`.
- Follow-up rescue requests can continue the latest Codex task in the repo.

### `/codex:transfer`

Creates a persistent Codex thread from a ZCode session and prints a `codex resume <session-id>` command.

```
/codex:transfer
/codex:transfer --source sess_<id>
/codex:transfer --source ~/.claude/projects/<...>/<id>.jsonl
```

**ZCode-specific behavior:** with no arguments (or `--source sess_<id>`), this reads the
conversation from `~/.zcode/cli/db/db.sqlite`, converts it into a Claude-format transcript on the
fly, and imports it into Codex via Codex's external-agent session importer. With
`--source <path-to-claude-jsonl>` it imports that Claude transcript directly.

> Transfer is best-effort: it depends on Codex's importer accepting the converted transcript.
> If it fails, the error will tell you what to do.

### `/codex:status`, `/codex:result`, `/codex:cancel`

```
/codex:status                 # active and recent Codex jobs for this repo
/codex:status task-abc123
/codex:result                 # final stored output of a finished job
/codex:result task-abc123
/codex:cancel                 # cancel an active background job
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated, and manages the optional review gate:

```
/codex:setup
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, a `Stop` hook runs a targeted Codex review based on the previous
turn; if it finds issues, the stop is blocked so they can be addressed first.

> [!WARNING]
> The review gate can create a long-running loop and drain usage limits quickly. Only enable it
> when you plan to actively monitor the session.

## How this differs from the Claude Code version

The Codex runtime itself (the `scripts/` directory, ~5,300 lines) is unchanged. The differences are
all in host integration:

| Area | Claude Code original | This ZCode port |
|---|---|---|
| **Hooks** | `SessionStart`, `SessionEnd`, `Stop` | `SessionStart`, `Stop` (ZCode has no `SessionEnd`; orphan broker/job cleanup runs on `SessionStart` instead) |
| **Session id** | read from stdin `session_id`, exported via `CLAUDE_ENV_FILE` | read from ZCode-injected `${CLAUDE_SESSION_ID}` env var, with stdin fallback |
| **`/codex:transfer`** | reads `~/.claude/projects/*.jsonl` directly | reads ZCode's SQLite store and converts to Claude format on the fly |
| **`/codex:rescue`** | routes through a `codex:codex-rescue` subagent | calls the companion `task` runtime directly (the subagent is kept for hosts that load plugin subagents) |
| **Manifests** | `.claude-plugin/plugin.json` | adds `.zcode-plugin/plugin.json` and a root `marketplace.json` (the `.claude-plugin/` files remain as a fallback) |

## Codex integration

The plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server) using your
global `codex` binary and [applies the same configuration](https://developers.openai.com/codex/config-basic).
Configure the default model/effort in `~/.codex/config.toml` or a project-level `.codex/config.toml`.

## License

Apache-2.0 (same as the upstream `openai/codex-plugin-cc`). See `LICENSE` and `NOTICE`.
