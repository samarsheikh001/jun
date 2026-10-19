import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLY_SIGNAL_GAP_MS, replySignalDelay, replySignalId } from "./protocol.ts";

test("replySignalDelay: now after the window, the rest of it inside", () => {
  assert.equal(replySignalDelay(0, 10_000), 0); // never sent
  assert.equal(replySignalDelay(1000, 1000 + REPLY_SIGNAL_GAP_MS), 0);
  assert.equal(replySignalDelay(1000, 1500), REPLY_SIGNAL_GAP_MS - 500);
  assert.equal(replySignalDelay(1000, 1000, 500), 500);
});

test("replySignalId: only a jun:reply with a plain id", () => {
  assert.equal(replySignalId({ type: "jun:reply", id: "cv_abc-1" }), "cv_abc-1");
  assert.equal(replySignalId({ type: "jun:reply" }), null);
  assert.equal(replySignalId({ type: "jun:reply", id: 4 }), null);
  assert.equal(replySignalId({ type: "jun:reply", id: "a/b" }), null);
  assert.equal(replySignalId({ type: "jun:reply", id: "x".repeat(65) }), null);
  assert.equal(replySignalId({ type: "jun:open", id: "cv_1" }), null);
  assert.equal(replySignalId(null), null);
  assert.equal(replySignalId("jun:reply"), null);
});
