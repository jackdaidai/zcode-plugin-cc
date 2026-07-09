import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnFailureMessage, resolveTurnTimeoutMs } from "../plugins/zcode/scripts/lib/zcode.mjs";

test("resolveTurnTimeoutMs defaults to 60 minutes", () => {
  assert.equal(resolveTurnTimeoutMs({}), 60 * 60 * 1000);
});

test("resolveTurnTimeoutMs honors ZCODE_TURN_TIMEOUT_MS", () => {
  assert.equal(resolveTurnTimeoutMs({ ZCODE_TURN_TIMEOUT_MS: "120000" }), 120000);
});

test("resolveTurnTimeoutMs rejects non-positive and malformed overrides", () => {
  const fallback = 60 * 60 * 1000;
  assert.equal(resolveTurnTimeoutMs({ ZCODE_TURN_TIMEOUT_MS: "0" }), fallback);
  assert.equal(resolveTurnTimeoutMs({ ZCODE_TURN_TIMEOUT_MS: "-5" }), fallback);
  assert.equal(resolveTurnTimeoutMs({ ZCODE_TURN_TIMEOUT_MS: "soon" }), fallback);
  assert.equal(resolveTurnTimeoutMs({}), fallback);
});

test("buildTurnFailureMessage distinguishes an abandoned wait from a server-reported failure", () => {
  const message = buildTurnFailureMessage({
    timedOut: true,
    completeReason: null,
    failureDetail: null,
    timeoutMs: 60 * 60 * 1000
  });
  assert.match(message, /did not complete within 60 minutes/);
  assert.match(message, /may still be running/);
  assert.match(message, /rate limiting/);
  assert.match(message, /ZCODE_TURN_TIMEOUT_MS/);
});

test("buildTurnFailureMessage surfaces prompt_failed with the captured detail", () => {
  const message = buildTurnFailureMessage({
    timedOut: false,
    completeReason: "prompt_failed",
    failureDetail: "429 rate limit reached",
    timeoutMs: 60 * 60 * 1000
  });
  assert.match(message, /prompt_failed: 429 rate limit reached/);
  assert.match(message, /rate limits/);
});

test("buildTurnFailureMessage keeps the generic message when nothing more is known", () => {
  const message = buildTurnFailureMessage({
    timedOut: false,
    completeReason: null,
    failureDetail: null,
    timeoutMs: 60 * 60 * 1000
  });
  assert.equal(message, "ZCode turn failed to produce output.");
});
