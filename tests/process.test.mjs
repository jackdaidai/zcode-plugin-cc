import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/zcode/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree escalates to SIGKILL on POSIX when SIGTERM is ignored", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    graceMs: 60,
    killImpl(target, signal) {
      calls.push([target, signal]);
      // Signal 0 is the aliveness probe; pretend the process never exits so the
      // escalation path has to fire.
      return true;
    }
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-group");
  assert.deepEqual(calls[0], [-1234, "SIGTERM"]);
  assert.deepEqual(calls[calls.length - 1], [-1234, "SIGKILL"]);
});

test("terminateProcessTree skips SIGKILL when the process exits during the grace period", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    graceMs: 60,
    killImpl(target, signal) {
      calls.push([target, signal]);
      if (signal === 0) {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-group");
  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, 0]
  ]);
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
