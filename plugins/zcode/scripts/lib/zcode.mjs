// ZCode engine wrapper — the ZCode equivalent of the Codex plugin's `lib/codex.mjs`.
//
// Exposes the SAME exported API the companion imports (so `zcode-companion.mjs` works
// unchanged apart from its import path), but talks the ZCode Protocol instead of the Codex
// app-server protocol. All method names/flows were confirmed by reverse-engineering
// `zcode app-server` (zcode 0.15.0):
//
//   - session/create  {workspace:{workspacePath,workspaceKey}} -> {session:{sessionId}, ...}
//   - session/send    {sessionId, content}                     -> {accepted, stateRevision} (async)
//   - session/read    {sessionId}                              -> {messages:[{info,parts}], ...}
//   - session/resume  {sessionId}                              -> reopens an existing session
//   - session/stop    {sessionId}                              -> cancels the active turn
//   - session/list    {}                                       -> {sessions:[...]}
//
// A turn completes asynchronously: session/send returns immediately, then `state.updated`
// notifications stream until params.reason === "prompt_completed". The assistant text lives
// in session/read's messages[].parts[] (type:"text").

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { BROKER_ENDPOINT_ENV, ZCodeAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

export const TASK_THREAD_PREFIX = "ZCode Companion Task";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

// ZCode state.updated reasons that mark the end of a turn.
const TURN_COMPLETE_REASONS = new Set(["prompt_completed", "prompt_cancelled", "prompt_failed"]);
// Safety upper bound for a single turn. If the server never emits a completion reason
// (model hang, dropped connection, provider rate-limit retries stretching the turn), we
// still resolve so the CLI never hangs forever. Heavy implementation tasks routinely run
// past 15 minutes, so the default is generous; override with ZCODE_TURN_TIMEOUT_MS (ms).
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;

export function resolveTurnTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env?.ZCODE_TURN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TURN_TIMEOUT_MS;
}

/**
 * Check that the `zcode` CLI is installed and exposes the app-server subcommand.
 */
export function getZCodeAvailability(cwd) {
  // `zcode` on Windows is a shim that Node's spawn can't resolve without shell:true.
  // binaryAvailable uses spawnSync without shell, so probe `zcode --version` via shell on win32.
  const versionStatus = binaryAvailable("zcode", ["--version"], { cwd, shell: process.platform === "win32" });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("zcode", ["app-server", "--help"], { cwd, shell: process.platform === "win32" });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared ZCode runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared ZCode runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

/**
 * Auth status. ZCode authenticates via `zcode login` (Z.AI OAuth) and persists shared
 * credentials; we infer logged-in state by whether a session can be created.
 */
export async function getZCodeAuthStatus(cwd, options = {}) {
  const availability = getZCodeAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await ZCodeAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    // ZCode has no auth handshake; verify by creating a throwaway session.
    const created = await createWorkspaceSession(client, cwd);
    const model = created.session?.model ?? null;
    return {
      available: true,
      loggedIn: true,
      detail: model ? `ZCode login active (${model.providerId || "z.ai"})` : "ZCode login active.",
      source: "app-server",
      authMethod: "zai-oauth",
      verified: true,
      requiresOpenaiAuth: false,
      provider: model?.providerId ?? null
    };
  } catch (error) {
    return {
      available: true,
      loggedIn: false,
      detail: `ZCode is installed but a session could not be created: ${error instanceof Error ? error.message : String(error)}. Run \`zcode login\`.`,
      source: "app-server",
      authMethod: null,
      verified: false,
      requiresOpenaiAuth: false,
      provider: null
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

function buildWorkspace(cwd) {
  const resolved = path.resolve(cwd);
  return { workspacePath: resolved, workspaceKey: resolved };
}

async function createWorkspaceSession(client, cwd) {
  const result = await client.request("session/create", { workspace: buildWorkspace(cwd) });
  return result;
}

/**
 * Send a prompt to a session and wait for the turn to complete by watching
 * state.updated notifications. Returns the final session/read snapshot.
 */
async function runTurnToCompletion(client, { sessionId, content, onProgress = null, timeoutMs = resolveTurnTimeoutMs() }) {
  let turnId = null;
  let completed = false;
  let completeReason = null;
  let timedOut = false;
  let failureDetail = null;

  const completion = new Promise((resolve) => {
    const previousHandler = client.notificationHandler;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      client.setNotificationHandler(previousHandler);
      resolve();
    };

    client.setNotificationHandler((message) => {
      if (message.method === "state.updated") {
        const params = message.params || {};
        // Ignore state updates for other sessions on a shared broker connection.
        if (params.sessionId && params.sessionId !== sessionId) {
          return;
        }
        if (params.turnId) {
          turnId = params.turnId;
        }
        const reason = params.reason;
        const status = params.patch?.status;
        // Best-effort capture of a failure detail if the server attaches one; the field is
        // not part of the confirmed protocol surface, so tolerate any shape.
        const errorDetail = params.patch?.error ?? params.error ?? null;
        if (errorDetail) {
          failureDetail =
            typeof errorDetail === "string" ? errorDetail : errorDetail.message ?? JSON.stringify(errorDetail);
        }
        if (onProgress) {
          onProgress({
            message: status === "running" ? "ZCode turn running…" : `ZCode turn ${reason || status}`,
            phase: status,
            threadId: sessionId,
            turnId
          });
        }
        if (TURN_COMPLETE_REASONS.has(reason) || (status === "idle" && reason && reason !== "prompt_started")) {
          completed = true;
          completeReason = reason;
          finish();
        }
        return;
      }
      previousHandler?.(message);
    });

    // Safety net: if the server never emits a completion reason, resolve anyway so the CLI
    // never hangs forever. The read() below will return whatever output exists.
    setTimeout(() => {
      if (!settled) {
        timedOut = true;
        onProgress?.({
          message: `ZCode turn timed out after ${formatTimeoutMinutes(timeoutMs)} minutes of waiting (the turn may still be running)`,
          phase: "timeout",
          threadId: sessionId,
          turnId
        });
      }
      finish();
    }, timeoutMs).unref?.();
  });

  await client.request("session/send", { sessionId, content });
  await completion;

  const snapshot = await client.request("session/read", { sessionId });
  return { snapshot, turnId, completed, completeReason, timedOut, failureDetail };
}

function extractAssistantText(messages) {
  const assistant = [...(messages || [])].reverse().find((m) => m.info?.role === "assistant");
  if (!assistant) {
    return "";
  }
  const textParts = (assistant.parts || [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text);
  return textParts.join("\n\n");
}

function extractReasoningSummary(messages) {
  const assistant = [...(messages || [])].reverse().find((m) => m.info?.role === "assistant");
  if (!assistant) {
    return [];
  }
  return (assistant.parts || [])
    .filter((p) => p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
    .filter(Boolean);
}

function extractTouchedFiles(messages) {
  const files = new Set();
  for (const m of messages || []) {
    for (const p of m.parts || []) {
      if (p.type === "tool" && p.state) {
        const input = p.state.input || {};
        for (const key of ["file_path", "path", "filePath"]) {
          if (typeof input[key] === "string") {
            files.add(input[key]);
          }
        }
      }
    }
  }
  return [...files];
}

function buildResultStatus({ completed, completeReason }) {
  if (!completed) {
    return "failed";
  }
  if (completeReason === "prompt_cancelled") {
    return "cancelled";
  }
  if (completeReason === "prompt_failed") {
    return "failed";
  }
  return "completed";
}

function formatTimeoutMinutes(timeoutMs) {
  return Math.max(1, Math.round(timeoutMs / 60000));
}

// The message an orchestrator sees when a turn fails without output. It must distinguish
// "we stopped waiting" (turn may still be running — often provider rate limiting) from
// "ZCode reported failure", so callers can pick the right recovery (resume vs fallback).
export function buildTurnFailureMessage({ timedOut, completeReason, failureDetail, timeoutMs }) {
  if (timedOut) {
    return (
      `ZCode turn did not complete within ${formatTimeoutMinutes(timeoutMs)} minutes and the wait was abandoned — ` +
      "the turn may still be running (e.g. provider rate limiting with retries, or a long task). " +
      "Check ~/.zcode/cli/log for the underlying cause (e.g. 429 rate limits), retry with --resume-last, " +
      "or raise the limit via ZCODE_TURN_TIMEOUT_MS."
    );
  }
  const detail = failureDetail ? `: ${failureDetail}` : "";
  if (completeReason === "prompt_failed") {
    return (
      `ZCode reported the turn as failed (prompt_failed${detail}). ` +
      "Check ~/.zcode/cli/log for the underlying error (e.g. provider rate limits)."
    );
  }
  return `ZCode turn failed to produce output${detail}.`;
}

/**
 * Run a single ZCode turn (the equivalent of Codex's runAppServerTurn).
 *
 * Options: { prompt, resumeThreadId, defaultPrompt, model, effort, sandbox, onProgress,
 *            persistThread, threadName }
 * ZCode ignores model/effort/sandbox at the protocol level (it uses its own config), but we
 * accept them for API compatibility. resumeThreadId maps to session/resume.
 */
export async function runAppServerTurn(cwd, options = {}) {
  let client = null;
  try {
    client = await ZCodeAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });

    let sessionId = options.resumeThreadId || null;
    if (sessionId) {
      // Reopen an existing session.
      await client.request("session/resume", { sessionId }).catch(() => {});
    } else {
      const created = await createWorkspaceSession(client, cwd);
      sessionId = created.session?.sessionId;
    }
    if (!sessionId) {
      throw new Error("ZCode did not return a session id.");
    }

    const prompt = options.prompt || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("No prompt provided for the ZCode turn.");
    }

    const timeoutMs = resolveTurnTimeoutMs();
    const { snapshot, turnId, completed, completeReason, timedOut, failureDetail } = await runTurnToCompletion(client, {
      sessionId,
      content: prompt,
      onProgress: options.onProgress,
      timeoutMs
    });

    const messages = snapshot.messages || [];
    const finalMessage = extractAssistantText(messages);
    const status = buildResultStatus({ completed, completeReason });

    return {
      status,
      threadId: sessionId,
      turnId,
      finalMessage,
      reasoningSummary: extractReasoningSummary(messages),
      touchedFiles: extractTouchedFiles(messages),
      error:
        status === "failed" && !finalMessage
          ? new Error(buildTurnFailureMessage({ timedOut, completeReason, failureDetail, timeoutMs }))
          : null
    };
  } catch (error) {
    return {
      status: "failed",
      threadId: options.resumeThreadId ?? null,
      turnId: null,
      finalMessage: "",
      reasoningSummary: [],
      touchedFiles: [],
      error
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * Run a code review. ZCode has no native `review/start` method, so this collects nothing
 * itself — the caller is expected to build a review prompt (with the git diff inlined) and
 * pass it as options.prompt. We run it as a read-only turn.
 */
export async function runAppServerReview(cwd, options = {}) {
  // options.target is accepted for API parity but the review content must come via prompt.
  if (!options.prompt) {
    throw new Error("ZCode review requires an inlined prompt (no native review target).");
  }
  return runAppServerTurn(cwd, {
    ...options,
    sandbox: "read-only"
  });
}

/**
 * Cancel the active turn on a session (the equivalent of Codex's turn/interrupt).
 */
export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  let client = null;
  try {
    client = await ZCodeAppServerClient.connect(cwd, {
      env: process.env,
      reuseExistingBroker: true
    });
    if (!threadId) {
      return { attempted: false, interrupted: false, detail: "No session id to interrupt." };
    }
    await client.request("session/stop", { sessionId: threadId });
    return { attempted: true, interrupted: true, detail: null };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * Import an external-agent session into ZCode. ZCode does not expose a Codex-style
 * externalAgentConfig/import RPC, so this is not supported via the app-server today.
 */
export async function importExternalAgentSession(cwd, options = {}) {
  throw new Error(
    "ZCode does not expose an external-agent session import via the app-server. " +
      "Open the converted transcript in the ZCode TUI (`zcode`) and resume it there, or use `/zcode:rescue --resume <sessionId>` to continue a session created in ZCode."
  );
}

/**
 * Find the latest persistent task session for this workspace (best-effort, via session/list).
 */
export async function findLatestTaskThread(cwd) {
  let client = null;
  try {
    client = await ZCodeAppServerClient.connect(cwd, { reuseExistingBroker: true });
    const result = await client.request("session/list", {});
    const sessions = result?.sessions || [];
    const resolved = path.resolve(cwd);
    const matching = sessions
      .filter((s) => s.workspace && path.resolve(s.workspace.workspacePath) === resolved)
      .filter((s) => (s.title || "").startsWith(TASK_THREAD_PREFIX))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const latest = matching[0];
    return latest ? { id: latest.sessionId } : null;
  } catch {
    return null;
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export function buildPersistentTaskThreadName(prompt) {
  const text = String(prompt || "").trim().replace(/\s+/g, " ");
  const shortened = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `${TASK_THREAD_PREFIX}: ${shortened || "Untitled"}`;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  // Codex used this to parse JSON review output. ZCode returns free-form text, so we pass
  // the raw text through and let the caller decide. We still attempt a JSON extraction.
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { parsed: null, rawOutput: text, parseError: fallback.failureMessage || "No output." };
  }
  // Try to locate a fenced or bare JSON object.
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return { parsed: JSON.parse(candidate), rawOutput: text, parseError: null };
  } catch {
    return { parsed: null, rawOutput: text, parseError: null };
  }
}

export function readOutputSchema(schemaPath) {
  // ZCode does not enforce a review schema, but the companion loads one for adversarial review.
  // Read it best-effort; ignore parse failures.
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
}
