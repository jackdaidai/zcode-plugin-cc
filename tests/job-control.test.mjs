import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob } from "../plugins/zcode/scripts/lib/state.mjs";
import { findActiveDuplicateWriteTask } from "../plugins/zcode/scripts/lib/job-control.mjs";

function withIsolatedState(run) {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return run(workspace);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

const SUMMARY = "Implement Story 001 of the Travel & Town Unlock System epic";

test("findActiveDuplicateWriteTask matches an active write task with the same summary", () => {
  withIsolatedState((workspace) => {
    upsertJob(workspace, {
      id: "task-existing",
      jobClass: "task",
      write: true,
      status: "running",
      summary: SUMMARY
    });

    const duplicate = findActiveDuplicateWriteTask(workspace, SUMMARY);
    assert.equal(duplicate?.id, "task-existing");
  });
});

test("findActiveDuplicateWriteTask matches a queued write task too", () => {
  withIsolatedState((workspace) => {
    upsertJob(workspace, {
      id: "task-queued",
      jobClass: "task",
      write: true,
      status: "queued",
      summary: SUMMARY
    });

    assert.equal(findActiveDuplicateWriteTask(workspace, SUMMARY)?.id, "task-queued");
  });
});

test("findActiveDuplicateWriteTask ignores read-only tasks with the same summary", () => {
  withIsolatedState((workspace) => {
    upsertJob(workspace, {
      id: "task-readonly",
      jobClass: "task",
      write: false,
      status: "running",
      summary: SUMMARY
    });

    assert.equal(findActiveDuplicateWriteTask(workspace, SUMMARY), null);
  });
});

test("findActiveDuplicateWriteTask ignores finished write tasks", () => {
  withIsolatedState((workspace) => {
    for (const status of ["completed", "failed", "cancelled"]) {
      upsertJob(workspace, {
        id: `task-${status}`,
        jobClass: "task",
        write: true,
        status,
        summary: SUMMARY
      });
    }

    assert.equal(findActiveDuplicateWriteTask(workspace, SUMMARY), null);
  });
});

test("findActiveDuplicateWriteTask ignores a different summary", () => {
  withIsolatedState((workspace) => {
    upsertJob(workspace, {
      id: "task-other",
      jobClass: "task",
      write: true,
      status: "running",
      summary: "Implement Story 001 of the Shop / Supply System epic"
    });

    assert.equal(findActiveDuplicateWriteTask(workspace, SUMMARY), null);
  });
});

test("findActiveDuplicateWriteTask ignores non-task jobs and empty summaries", () => {
  withIsolatedState((workspace) => {
    upsertJob(workspace, {
      id: "review-active",
      jobClass: "review",
      write: true,
      status: "running",
      summary: SUMMARY
    });

    assert.equal(findActiveDuplicateWriteTask(workspace, SUMMARY), null);
    assert.equal(findActiveDuplicateWriteTask(workspace, "   "), null);
  });
});
