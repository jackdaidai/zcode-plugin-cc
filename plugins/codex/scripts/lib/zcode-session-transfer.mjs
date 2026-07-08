// ZCode → Claude transcript converter for the /codex:transfer command.
//
// Background: Codex's `externalAgentConfig/import` (used by transfer) only accepts
// Claude-style session transcripts — newline-delimited JSON objects shaped like:
//   { type:"user"|"assistant", uuid, parentUuid, sessionId, timestamp, cwd,
//     message:{ role, content<string|Block[]>, model?, stop_reason?, usage? } }
// where an assistant content Block is one of {type:"text",text} / {type:"tool_use",id,name,input}
// and a tool result is a follow-up user record with content {type:"tool_result",tool_use_id,content}.
//
// ZCode does not store this. Its conversation lives in SQLite (~/.zcode/cli/db/db.sqlite):
//   - message rows carry metadata in `data` (role, time, modelID, providerID, finish, path.cwd...)
//   - part rows carry the rendered content (type: text | reasoning | tool | step-start | step-finish)
// This module reads those rows for a session and emits a Claude-shaped jsonl string/file.
//
// The mapping is intentionally lossy but faithful enough that Codex's importer reconstructs a
// readable, resumable turn history. Reasoning parts are dropped (they are not conversation turns);
// step-start/step-finish are dropped (control markers); tool parts become tool_use/tool_result pairs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// node:sqlite is available in Node 22+ behind no flag (still flagged "experimental" at v24).
// The plugin requires Node >= 18.18, so we must guard the import.
let DatabaseSync = null;
try {
  // Use a dynamic property access so older Node versions that lack the module fail gracefully
  // at call time with a clear message rather than at module load.
  DatabaseSync = (await import("node:sqlite")).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const ZCODE_DB_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

export function resolveZCodeDbPath() {
  return ZCODE_DB_PATH;
}

function isZCodeSessionId(value) {
  return typeof value === "string" && /^sess_[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * Resolve which ZCode session to export.
 * Priority: explicit sessionId arg > CLAUDE_SESSION_ID env > the most recent session in the DB.
 */
function resolveSessionId(db, explicit) {
  if (explicit && isZCodeSessionId(explicit)) {
    return explicit.trim();
  }
  const env = process.env.CLAUDE_SESSION_ID;
  if (env && isZCodeSessionId(env)) {
    return env.trim();
  }
  const row = db
    .prepare("SELECT id FROM session ORDER BY time_updated DESC LIMIT 1")
    .get();
  return row?.id ?? null;
}

function loadSession(db, sessionId) {
  return db
    .prepare("SELECT id, directory, title FROM session WHERE id = ?")
    .get(sessionId);
}

function loadMessages(db, sessionId) {
  return db
    .prepare(
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
    )
    .all(sessionId);
}

function loadParts(db, messageId) {
  return db
    .prepare(
      "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC"
    )
    .all(messageId)
    .map((row) => JSON.parse(row.data));
}

function isoFromEpochMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return new Date().toISOString();
  }
  return new Date(ms).toISOString();
}

function cwdFromMessage(messageData, fallback) {
  return messageData?.path?.cwd || messageData?.path?.root || fallback || process.cwd();
}

function modelFromMessage(messageData) {
  return messageData?.modelID || messageData?.model?.modelID || null;
}

function mapStopReason(finish) {
  // ZCode finish -> Claude stop_reason
  switch (finish) {
    case "stop":
      return "end_turn";
    case "tool-calls":
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return finish || null;
  }
}

function truncateForLog(value, limit = 200) {
  const s = String(value ?? "");
  return s.length <= limit ? s : s.slice(0, limit) + "…";
}

/**
 * Build the Claude-shape content blocks for an assistant message from its parts.
 * Tool parts are emitted as tool_use blocks; the matching tool_result records are
 * returned separately so the caller can append them as follow-up user turns.
 */
function buildAssistantContentAndResults(parts) {
  const blocks = [];
  const toolResults = [];

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    // Reasoning/step markers are agent-internal and not conversation turns.
    if (part.type === "tool") {
      const state = part.state || {};
      const name = part.tool || "tool";
      const input = state.input ?? {};
      const callId = part.callID || randomUUID();
      blocks.push({ type: "tool_use", id: callId, name, input });
      toolResults.push({
        type: "tool_result",
        tool_use_id: callId,
        content:
          typeof state.output === "string"
            ? state.output
            : state.error
              ? `error: ${truncateForLog(state.error)}`
              : JSON.stringify(state.output ?? state.error ?? ""),
        is_error: state.status === "error" ? true : undefined
      });
    }
  }

  return { blocks, toolResults };
}

function buildUserContent(parts) {
  // A user turn is normally a single text part.
  const texts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text);
  if (texts.length === 0) {
    return "";
  }
  return texts.join("\n\n");
}

function makeRecord({ type, uuid, parentUuid, sessionId, timestamp, cwd, message }) {
  return {
    parentUuid,
    isSidechain: false,
    type,
    uuid,
    timestamp,
    cwd,
    sessionId,
    message,
    userType: type === "user" ? "external" : undefined,
    version: "2.0.0"
  };
}

/**
 * Convert a ZCode session into a Claude-format transcript (array of jsonl lines).
 * Returns { lines, sessionId, directory, title, messageCount }.
 */
export function convertZCodeSessionToClaudeTranscript(sessionIdExplicit, options = {}) {
  if (!DatabaseSync) {
    throw new Error(
      "This Node version does not provide node:sqlite. Use Node 22+ to transfer a ZCode session, or pass --source <claude-jsonl>."
    );
  }

  const dbPath = options.dbPath || ZCODE_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Could not find the ZCode session database at ${dbPath}.`);
  }

  // Open read-only. WAL mode means a hot DB can be read without taking the write lock.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessionId = resolveSessionId(db, sessionIdExplicit);
    if (!sessionId) {
      throw new Error("Could not determine the ZCode session to transfer. Pass a session id (sess_...) via --source.");
    }
    const session = loadSession(db, sessionId);
    if (!session) {
      throw new Error(`No ZCode session found with id ${sessionId}.`);
    }
    const cwd = session.directory || process.cwd();
    const messages = loadMessages(db, sessionId);

    const lines = [];
    let parentUuid = null;
    let turned = 0;

    for (const message of messages) {
      const data = JSON.parse(message.data);
      const role = data.role;
      const uuid = message.id;
      const timestamp = isoFromEpochMs(message.time_created);
      const parts = loadParts(db, message.id);

      if (role === "user") {
        const content = buildUserContent(parts);
        if (!content) {
          // Skip empty user turns (e.g. meta/system entries).
          continue;
        }
        lines.push(
          makeRecord({
            type: "user",
            uuid,
            parentUuid,
            sessionId,
            timestamp,
            cwd,
            message: { role: "user", content }
          })
        );
        parentUuid = uuid;
        turned++;
        continue;
      }

      if (role === "assistant") {
        const { blocks, toolResults } = buildAssistantContentAndResults(parts);
        if (blocks.length === 0) {
          continue;
        }
        const assistantMessage = {
          role: "assistant",
          content: blocks
        };
        const model = modelFromMessage(data);
        if (model) {
          assistantMessage.model = model;
        }
        const stopReason = mapStopReason(data.finish);
        if (stopReason) {
          assistantMessage.stop_reason = stopReason;
        }
        lines.push(
          makeRecord({
            type: "assistant",
            uuid,
            parentUuid,
            sessionId,
            timestamp,
            cwd,
            message: assistantMessage
          })
        );
        parentUuid = uuid;
        turned++;

        // Append tool results as follow-up user turn(s), mirroring Claude transcripts.
        if (toolResults.length > 0) {
          const resultUuid = `${uuid}-results`;
          lines.push(
            makeRecord({
              type: "user",
              uuid: resultUuid,
              parentUuid,
              sessionId,
              timestamp,
              cwd,
              message: { role: "user", content: toolResults }
            })
          );
          parentUuid = resultUuid;
          turned++;
        }
      }
    }

    return {
      lines,
      sessionId,
      directory: cwd,
      title: session.title || null,
      messageCount: turned
    };
  } finally {
    db.close();
  }
}

/**
 * Convert a ZCode session to a temporary Claude-format jsonl file and return its path.
 * The caller is responsible for importing it into Codex (and ideally cleaning it up).
 */
export function writeZCodeSessionAsClaudeTranscript(sessionIdExplicit, options = {}) {
  const result = convertZCodeSessionToClaudeTranscript(sessionIdExplicit, options);
  if (result.lines.length === 0) {
    throw new Error("The ZCode session has no convertible turns (no user/assistant text or tool calls).");
  }
  const tempDir = options.tempDir || os.tmpdir();
  const fileBase = result.sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  const outPath = path.join(tempDir, `zcode-${fileBase}-${Date.now()}.jsonl`);
  fs.writeFileSync(outPath, result.lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return { ...result, sourcePath: outPath };
}
