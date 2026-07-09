// ZCode Protocol app-server client.
//
// This is the ZCode equivalent of the Codex plugin's `lib/app-server.mjs`. It speaks the
// ZCode Protocol (a JSON-RPC-like line protocol used by `zcode app-server`) instead of the
// Codex app-server protocol.
//
// Key differences from the Codex original, all confirmed by reverse-engineering
// `zcode app-server` (zcode 0.15.0):
//
//   1. Message framing is `{ id, method, params }` for requests and `{ id, result | error }`
//      for responses — identical to JSON-RPC *except* there is NO `jsonrpc` field. Sending
//      `jsonrpc` makes the server reject the message ("Invalid ZCode Protocol message").
//   2. There is NO `initialize` / `initialized` handshake. The connection is ready as soon as
//      the process starts. The first real call is `session/create`.
//   3. The server is launched as `node <zcode.cjs> app-server`, not `codex app-server`. On
//      Windows, `spawn("zcode", ...)` fails with ENOENT because the launcher is a shim, so we
//      resolve the real entrypoint and spawn node directly.
//   4. ZCode methods live under the `session/*` namespace (session/create, session/send,
//      session/read, session/resume, session/stop, session/compact, session/list). There is
//      no `thread/*`, `turn/*`, or `review/*` namespace.
//
// The exported entry point is `ZCodeAppServerClient`.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "ZCODE_COMPANION_APP_SERVER_ENDPOINT";
// Back-compat alias for any caller that still references the Codex env name.
export const CODEX_BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

/** Default client identity reported to the server (informational only — ZCode has no handshake). */
const DEFAULT_CLIENT_INFO = {
  title: "ZCode Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = new Error(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

/**
 * Resolve the ZCode CLI entrypoint that `zcode app-server` ultimately runs.
 * On Windows the `zcode` on PATH is a shim, so spawning it directly from Node fails
 * (ENOENT). We prefer the well-known install location; falling back to the `zcode`
 * binary (works on macOS/Linux where the shim is exec-able).
 */
function resolveZCodeServerCommand() {
  const candidates = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
    // macOS app bundle layout (best-effort; the Windows path above is the primary case).
    "/Applications/ZCode.app/Contents/Resources/resources/glm/zcode.cjs"
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { command: process.execPath, args: [candidate, "app-server"] };
      }
    } catch {
      // ignore and try the next candidate
    }
  }
  // Fallback: rely on PATH resolution. On Windows the `zcode` shim is not directly
  // exec-able from Node (ENOENT), so route the spawn through the shell there.
  return { command: "zcode", args: ["app-server"], shell: process.platform === "win32" };
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  // Send a request. Note: NO `jsonrpc` field — ZCode Protocol rejects it.
  request(method, params) {
    if (this.closed) {
      throw new Error("zcode app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse zcode app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `zcode app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("zcode app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedZCodeAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const { command, args, shell } = this.options.serverCommand ?? resolveZCodeServerCommand();
    this.proc = spawn(command, args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: shell ?? false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `zcode app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    // ZCode Protocol has no initialize handshake — the process is ready once started.
    // We surface clientInfo only for diagnostics (unused by the server).
    void DEFAULT_CLIENT_INFO;
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      // The ZCode app-server does not exit on stdin EOF (unlike codex app-server), so we
      // cannot rely on exitPromise resolving. Kill the whole process tree proactively,
      // destroy the stdio streams so they stop holding the event loop open, and resolve
      // close() without waiting for an exit event that may never come.
      try {
        this.proc.stdin.end();
      } catch {
        // stdin may already be closed.
      }
      try {
        terminateProcessTree(this.proc.pid);
      } catch {
        // Best-effort cleanup; swallow errors during shutdown.
      }
      try {
        this.proc.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        this.proc.stderr?.destroy();
      } catch {
        // ignore
      }
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("zcode app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerZCodeAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    // The broker is line-protocol transparent; no initialize handshake is needed.
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.socket) {
      // End the socket; do not block on exitPromise (it resolves on close, but we don't
      // need to wait for it).
      try {
        this.socket.end();
      } catch {
        // socket may already be destroyed.
      }
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("zcode app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class ZCodeAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ??
        options.env?.[BROKER_ENDPOINT_ENV] ??
        process.env[BROKER_ENDPOINT_ENV] ??
        options.env?.[CODEX_BROKER_ENDPOINT_ENV] ??
        process.env[CODEX_BROKER_ENDPOINT_ENV] ??
        null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerZCodeAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedZCodeAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
