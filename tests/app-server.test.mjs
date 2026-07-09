import test from "node:test";
import assert from "node:assert/strict";

import { AppServerClientBase } from "../plugins/zcode/scripts/lib/app-server.mjs";

// Minimal concrete subclass that captures the last message sent to the server, so we can
// assert on how handleServerRequest answers interaction/requestPermission requests.
class CapturingClient extends AppServerClientBase {
  constructor(options = {}) {
    super(process.cwd(), options);
    this.sent = [];
  }

  sendMessage(message) {
    this.sent.push(message);
  }
}

// Build an interaction/requestPermission server request the way the ZCode app-server would.
function permissionRequest(id, { riskLevel, options = [] } = {}) {
  return {
    id,
    method: "interaction/requestPermission",
    params: { riskLevel, options }
  };
}

// Server-supplied option objects mirror the shape the app-server presents for a prompt.
const ALLOW_OPT = {
  response: { decision: "allow", updatedInput: {}, undoDescriptor: null }
};
const DENY_OPT = {
  response: { decision: "deny", reason: "server deny" }
};

function lastReply(client) {
  return client.sent[client.sent.length - 1];
}

test("handleServerRequest allows low/medium risk under workspace-write, denying high", () => {
  const client = new CapturingClient({ permissionPolicy: "workspace-write" });

  client.handleServerRequest(permissionRequest(1, { riskLevel: "low" }));
  client.handleServerRequest(permissionRequest(2, { riskLevel: "medium" }));
  client.handleServerRequest(permissionRequest(3, { riskLevel: "high" }));

  assert.equal(client.sent[0].id, 1);
  assert.deepEqual(client.sent[0].result, { decision: "allow" });
  assert.deepEqual(client.sent[1].result, { decision: "allow" });
  assert.equal(client.sent[2].result.decision, "deny");
  assert.match(client.sent[2].result.reason, /high.*requires interactive approval/);
});

test("handleServerRequest prefers the server-supplied allow option when present", () => {
  const client = new CapturingClient({ permissionPolicy: "workspace-write" });

  client.handleServerRequest(
    permissionRequest(1, { riskLevel: "medium", options: [DENY_OPT, ALLOW_OPT] })
  );

  // The handler picks the allow option's response object verbatim rather than synthesizing one.
  assert.deepEqual(lastReply(client).result, ALLOW_OPT.response);
});

test("handleServerRequest denies everything under read-only, regardless of risk", () => {
  const client = new CapturingClient({ permissionPolicy: "read-only" });

  for (const risk of ["low", "medium", "high"]) {
    client.handleServerRequest(permissionRequest(1, { riskLevel: risk }));
    assert.equal(lastReply(client).result.decision, "deny");
    assert.equal(lastReply(client).result.reason, "zcode-companion read-only run");
  }
});

test("handleServerRequest denies high risk under workspace-write unless autoAllowHighRisk", () => {
  const client = new CapturingClient({
    permissionPolicy: "workspace-write",
    autoAllowHighRisk: true
  });

  client.handleServerRequest(permissionRequest(1, { riskLevel: "high" }));
  assert.deepEqual(lastReply(client).result, { decision: "allow" });

  // autoAllowHighRisk does not weaken read-only policy.
  const readOnly = new CapturingClient({
    permissionPolicy: "read-only",
    autoAllowHighRisk: true
  });
  readOnly.handleServerRequest(permissionRequest(1, { riskLevel: "high" }));
  assert.equal(lastReply(readOnly).result.decision, "deny");
});

test("handleServerRequest treats a missing riskLevel as high (conservative default)", () => {
  const client = new CapturingClient({ permissionPolicy: "workspace-write" });

  client.handleServerRequest(permissionRequest(1, {}));

  assert.equal(lastReply(client).result.decision, "deny");
  assert.match(lastReply(client).result.reason, /high.*requires interactive approval/);
});

test("handleServerRequest still errors on unsupported server requests", () => {
  const client = new CapturingClient({ permissionPolicy: "workspace-write" });

  client.handleServerRequest({ id: 1, method: "some/otherRequest", params: {} });

  const reply = lastReply(client);
  assert.equal(reply.id, 1);
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /Unsupported server request/);
});
