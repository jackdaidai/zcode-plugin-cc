#!/usr/bin/env node

// ZCode port of the Codex Companion session-lifecycle hook.
//
// Differences from the Claude Code original:
//   - ZCode only supports seven hook events and SessionEnd is NOT among them,
//     so this script only handles SessionStart. The broker/job teardown that the
//     original did on SessionEnd is instead done opportunistically on SessionStart
//     (clean up orphan broker + jobs from a previous session for this workspace).
//   - ZCode does not provide a CLAUDE_ENV_FILE to export session-scoped env vars.
//     Instead, ZCode injects ${CLAUDE_SESSION_ID} as an environment variable into
//     command hooks (documented in the diagnosing-hooks skill). We read that env
//     var, fall back to the stdin payload's session_id, and surface it as
//     CODEX_COMPANION_SESSION_ID so the rest of the runtime can keep using it.
//   - All session-id sources are optional. When none are present, session-scoped
//     job filtering simply degrades to "all jobs for this workspace", which keeps
//     review / rescue working.

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// Defined locally (rather than imported from claude-session-transfer.mjs) to avoid pulling
// the node:sqlite-backed converter into this lightweight lifecycle hook. The value must stay
// in sync with TRANSCRIPT_PATH_ENV in lib/claude-session-transfer.mjs.
const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
// ZCode injects the current session id as this env var into command hooks.
const ZCODE_SESSION_ID_ENV = "CLAUDE_SESSION_ID";
// Jobs whose age exceeds this threshold are considered orphans and cleaned up.
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // ZCode's stdin payload shape for SessionStart is not explicitly documented;
    // tolerate non-JSON / empty input and fall back to environment variables.
    return {};
  }
}

function resolveSessionId(input) {
  return (
    process.env[ZCODE_SESSION_ID_ENV] ||
    (typeof input.session_id === "string" && input.session_id) ||
    process.env[SESSION_ID_ENV] ||
    null
  );
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const now = Date.now();
  const survivors = [];
  let changed = false;

  for (const job of state.jobs) {
    // Drop jobs that belong to the current session, OR orphaned jobs older than the TTL.
    const isCurrentSession = sessionId && job.sessionId === sessionId;
    const updatedAt = job.updatedAt ? Date.parse(job.updatedAt) : NaN;
    const isOrphan = !Number.isNaN(updatedAt) && now - updatedAt > ORPHAN_TTL_MS;
    if (isCurrentSession || isOrphan) {
      changed = true;
      if (job.status === "queued" || job.status === "running") {
        try {
          terminateProcessTree(job.pid ?? Number.NaN);
        } catch {
          // Ignore teardown failures during session startup tidy-up.
        }
      }
      continue;
    }
    survivors.push(job);
  }

  if (changed) {
    saveState(workspaceRoot, { ...state, jobs: survivors });
  }
}

async function cleanupOrphanBroker(cwd) {
  if (!cwd) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const existing = loadBrokerSession(workspaceRoot);
  if (!existing) {
    return;
  }
  // If the broker endpoint is still live, leave it alone — it may be reused.
  const ready = await waitForBrokerEndpoint(existing.endpoint, 150).catch(() => false);
  if (ready) {
    return;
  }
  // Stale broker from a previous session: shut it down and clear the record.
  await sendBrokerShutdown(existing.endpoint).catch(() => {});
  teardownBrokerSession({
    endpoint: existing.endpoint ?? null,
    pidFile: existing.pidFile ?? null,
    logFile: existing.logFile ?? null,
    sessionDir: existing.sessionDir ?? null,
    pid: existing.pid ?? null,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(workspaceRoot);
}

function handleSessionStart(input) {
  // Best-effort: surface the resolved session id for the rest of the runtime.
  // ZCode hooks run as one-shot processes, so we cannot export into the parent
  // shell; instead we set it on process.env so any child process spawned within
  // this hook invocation inherits it, and persist a marker the companion reads.
  const sessionId = resolveSessionId(input);
  if (sessionId) {
    process.env[SESSION_ID_ENV] = sessionId;
  }
  // Keep a transcript path if ZCode ever surfaces one (currently undocumented);
  // the transfer command can also pick it up via --source.
  if (input.transcript_path) {
    process.env[TRANSCRIPT_PATH_ENV] = input.transcript_path;
  }
  // PLUGIN_DATA is already injected by ZCode; nothing to forward here.
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    const cwd =
      input.cwd ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.env.ZCODE_PROJECT_DIR ||
      process.cwd();
    const sessionId = resolveSessionId(input);
    // Opportunistic cleanup of leftovers from a previous session (SessionEnd is
    // unavailable in ZCode, so we tidy up here instead).
    cleanupSessionJobs(cwd, sessionId);
    await cleanupOrphanBroker(cwd);
    return;
  }

  // SessionEnd is not a supported ZCode event; ignore it defensively if ever fired.
  if (eventName === "SessionEnd") {
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
