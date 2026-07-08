import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";
import { writeZCodeSessionAsClaudeTranscript } from "./zcode-session-transfer.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function isZCodeSessionId(value) {
  return typeof value === "string" && /^sess_[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * Resolve a Claude-format jsonl source path for the transfer command.
 *
 * ZCode port behavior:
 *   - No --source and no transcript env: convert the CURRENT ZCode session
 *     (from ~/.zcode/cli/db/db.sqlite) into a temp Claude jsonl file.
 *   - --source is a ZCode session id (sess_...): convert THAT session.
 *   - --source is a real .jsonl file: use it directly. If it lives under
 *     ~/.claude/projects we keep the original strict check; otherwise we accept
 *     any readable jsonl (e.g. a previously-exported file or a ZCode temp export).
 */
export async function resolveTransferSourcePath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];

  // Path A: ZCode session id (or nothing → current session) → DB conversion.
  if (!requestedPath || isZCodeSessionId(requestedPath)) {
    const sessionId = requestedPath ? requestedPath.trim() : undefined;
    const result = writeZCodeSessionAsClaudeTranscript(sessionId, options);
    return result.sourcePath;
  }

  // Path B: a real jsonl file.
  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(
      `Session source must be a JSONL file or a ZCode session id (sess_...): ${sourcePath}`
    );
  }

  let source;
  try {
    source = fs.realpathSync(sourcePath);
  } catch {
    throw new Error(`Session file not found: ${sourcePath}`);
  }

  // Keep the original guarantee for files that live in the Claude projects store.
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    try {
      const projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
      const relative = path.relative(projects, source);
      const insideClaude =
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      if (insideClaude) {
        return source;
      }
    } catch {
      // Claude projects dir not resolvable; fall through to the permissive path.
    }
  }

  // Permissive: any other readable jsonl (exported transcripts, temp files, etc.).
  return source;
}

// Back-compat export for any caller still using the original name.
export async function resolveClaudeSessionPath(cwd, options = {}) {
  return resolveTransferSourcePath(cwd, options);
}
