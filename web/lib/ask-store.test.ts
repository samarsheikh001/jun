import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProposedAction } from "../../shared/desk-assistant.ts";
import { addRecent, askKey, EXPIRED, MAX_RECENT, MAX_TURNS, restoreAsk, serialiseAsk, trimTurns, type Turn } from "./ask-store.ts";

const ids = () => {
  let n = 100;
  return () => n++;
};
const note: ProposedAction = { callId: "c1", tool: "propose_note", proposal: { kind: "note", conversationId: "cv_1", body: "Check billing" }, labels: { conversation: "Ada" }, summary: "Add a note" };

test("askKey: per workspace and member", () => {
  assert.equal(askKey("ws_1", "usr_2"), "jun:ask:ws_1:usr_2");
});

test("serialise and restore: turns come back with fresh ids", () => {
  const turns: Turn[] = [
    { id: 1, role: "user", text: "What broke?" },
    { id: 2, role: "assistant", text: "Billing.", took: 1200, steps: [{ id: "s1", tool: "search_conversations", label: "Searched chats", status: "done", result: "3 chats" }] },
    { id: 3, role: "error", text: "Timed out" },
  ];
  const back = restoreAsk(serialiseAsk(turns, ["What broke?"]), ids());
  assert.deepEqual(back.recent, ["What broke?"]);
  assert.deepEqual(back.turns.map((t) => t.id), [100, 101, 102]);
  assert.deepEqual(back.turns.map(({ id: _id, ...t }) => t), turns.map(({ id: _id, ...t }) => t));
});

test("restore: a waiting card comes back expired, a settled one as it was", () => {
  const raw = serialiseAsk([{ id: 1, role: "user", text: "Note it" }, { id: 2, role: "assistant", text: "", proposal: note }, { id: 3, role: "assistant", text: "", proposal: note, outcome: { status: "done" } }], []);
  const [, waiting, done] = restoreAsk(raw, ids()).turns;
  assert.deepEqual(waiting!.role === "assistant" && waiting!.outcome, EXPIRED);
  assert.deepEqual(done!.role === "assistant" && done!.outcome, { status: "done" });
});

test("restore: anything that doesn't parse is empty; bad turns and fields are dropped", () => {
  for (const raw of [null, "", "{", "[]", '{"v":2,"turns":[]}', '{"turns":[]}']) assert.deepEqual(restoreAsk(raw, ids()), { turns: [], recent: [] });
  const raw = JSON.stringify({
    v: 1,
    turns: [{ role: "user", text: "Hi" }, { role: "robot", text: "x" }, { role: "user" }, { role: "assistant", text: "Yo", steps: [{ id: 1 }, { id: "s", tool: "t", label: "L", status: "running" }], proposal: { callId: "c", proposal: { kind: "nuke" } } }],
    recent: ["a", 3, "b"],
  });
  const back = restoreAsk(raw, ids());
  assert.deepEqual(back.recent, ["a", "b"]);
  assert.deepEqual(back.turns, [{ id: 100, role: "user", text: "Hi" }, { id: 103, role: "assistant", text: "Yo", steps: [{ id: "s", tool: "t", label: "L", status: "error" }] }]);
});

test("trimTurns: the last turns, starting at a question, within the size cap", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }) as const);
  const kept = trimTurns(many);
  assert.ok(kept.length <= MAX_TURNS);
  assert.equal(kept[0]!.role, "user");
  assert.equal(kept.at(-1)!.text, "t39");
  const big = [{ role: "user", text: "a".repeat(600) }, { role: "assistant", text: "b".repeat(600) }, { role: "user", text: "c" }, { role: "assistant", text: "d" }] as const;
  assert.deepEqual(trimTurns([...big], 500).map((t) => t.text), ["c", "d"]);
  assert.deepEqual(trimTurns([{ role: "assistant", text: "orphan" }]), []);
});

test("addRecent: newest first, once each, capped", () => {
  let r: string[] = [];
  for (const q of ["One", "Two", "  one ", "Three", "Four", "Five", "Six", ""]) r = addRecent(r, q);
  assert.deepEqual(r, ["Six", "Five", "Four", "Three", "one"]);
  assert.equal(r.length, MAX_RECENT);
});
