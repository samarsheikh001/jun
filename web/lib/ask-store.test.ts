import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProposedAction } from "../../shared/desk-assistant.ts";
import { addRecent, askKey, EXPIRED, MAX_RECENT, MAX_THREADS, MAX_TURNS, mergeThreads, readServerThread, restoreAsk, serialiseAsk as serialiseState, serverThread, threadTitle, trimTurns, upsertThread, type SavedThread, type Turn } from "./ask-store.ts";

// One thread, as D-132 kept it: the v2 store with a single thread.
const serialiseAsk = (turns: Turn[], recent: string[]) => serialiseState({ current: "t1", threads: [{ id: "t1", title: "", updatedAt: 1, turns }], recent });
const restoreOne = (raw: string | null, nextId: () => number) => {
  const s = restoreAsk(raw, nextId);
  return { turns: s.threads[0]?.turns ?? [], recent: s.recent };
};

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
  const back = restoreOne(serialiseAsk(turns, ["What broke?"]), ids());
  assert.deepEqual(back.recent, ["What broke?"]);
  assert.deepEqual(back.turns.map((t) => t.id), [100, 101, 102]);
  assert.deepEqual(back.turns.map(({ id: _id, ...t }) => t), turns.map(({ id: _id, ...t }) => t));
});

test("restore: a waiting card comes back expired, a settled one as it was", () => {
  const raw = serialiseAsk([{ id: 1, role: "user", text: "Note it" }, { id: 2, role: "assistant", text: "", proposal: note }, { id: 3, role: "assistant", text: "", proposal: note, outcome: { status: "done" } }], []);
  const [, waiting, done] = restoreOne(raw, ids()).turns;
  assert.deepEqual(waiting!.role === "assistant" && waiting!.outcome, EXPIRED);
  assert.deepEqual(done!.role === "assistant" && done!.outcome, { status: "done" });
});

test("restore: anything that doesn't parse is empty; bad turns and fields are dropped", () => {
  for (const raw of [null, "", "{", "[]", '{"v":2,"turns":[]}', '{"turns":[]}']) assert.deepEqual(restoreOne(raw, ids()), { turns: [], recent: [] });
  const raw = JSON.stringify({
    v: 1,
    turns: [{ role: "user", text: "Hi" }, { role: "robot", text: "x" }, { role: "user" }, { role: "assistant", text: "Yo", steps: [{ id: 1 }, { id: "s", tool: "t", label: "L", status: "running" }], proposal: { callId: "c", proposal: { kind: "nuke" } } }],
    recent: ["a", 3, "b"],
  });
  const back = restoreOne(raw, ids());
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

test("serialise: an invite link made on a card isn't stored (D-133); new kinds come back", () => {
  const invite: ProposedAction = { callId: "abc123xyz", tool: "propose_team", proposal: { kind: "team_invite", role: "agent" }, labels: {}, summary: "Make an invite link" };
  const file: ProposedAction = { callId: "abc123xyz", tool: "propose_agent_file", proposal: { kind: "agent_file", path: "instructions.md", op: "edit", before: "a\n", after: "b\n" }, labels: {}, summary: "Change instructions.md" };
  const turns: Turn[] = [
    { id: 1, role: "user", text: "Invite Sam" },
    { id: 2, role: "assistant", text: "", proposal: invite, outcome: { status: "done", detail: "made", link: "https://desk/invite/secret" } },
    { id: 3, role: "assistant", text: "", proposal: file, outcome: { status: "done", detail: "version 3" } },
  ];
  const raw = serialiseAsk(turns, []);
  assert.doesNotMatch(raw, /secret/);
  const back = restoreOne(raw, () => 0).turns;
  assert.equal(back.length, 3);
  assert.deepEqual(back[1]!.role === "assistant" && back[1]!.outcome, { status: "done", detail: "made" });
  assert.equal(back[2]!.role === "assistant" && back[2]!.proposal?.proposal.kind, "agent_file");
});

test("ask store: a bulk card's rows come back (D-134)", () => {
  const bulk = { kind: "bulk", op: "status", status: "resolved", conversationIds: ["cv_1", "cv_2"], items: [{ conversationId: "cv_1", customer: "Hana", before: "open", after: "resolved" }] };
  const turns = [
    { id: 1, role: "user" as const, text: "resolve them" },
    { id: 2, role: "assistant" as const, text: "", proposal: { callId: "abcdefghi", tool: "propose_bulk" as const, proposal: bulk as never, labels: {}, summary: "Resolve 1 chat" }, outcome: { status: "done" as const, detail: "1 done", results: [{ conversationId: "cv_1", status: "done" }] as never } },
  ];
  let id = 0;
  const back = restoreOne(serialiseAsk(turns, []), () => ++id);
  const a = back.turns[1] as Extract<(typeof back.turns)[number], { role: "assistant" }>;
  // D-144: rows stored before results had `id` (D-134 called it conversationId) read back as `id`.
  assert.deepEqual(a.outcome?.results, [{ id: "cv_1", status: "done" }]);
  const broken = restoreOne(serialiseAsk([turns[0]!, { ...turns[1]!, proposal: { ...turns[1]!.proposal, proposal: { ...bulk, items: "x" } as never } } as Turn], []), () => ++id);
  assert.equal((broken.turns[1] as { proposal?: unknown }).proposal, undefined);
  const del = { kind: "bulk_delete", target: "tag", ids: ["tg_1", "tg_2"], items: [{ id: "tg_1", name: "old", detail: "on 2 chats" }, { id: "tg_2", name: "older", detail: "on 0 chats" }] };
  const delTurns = [turns[0]!, { ...turns[1]!, proposal: { ...turns[1]!.proposal, tool: "propose_bulk_delete" as const, proposal: del as never }, outcome: { status: "done" as const, detail: "2 done", results: [{ id: "tg_1", status: "done" as const }, { id: "tg_2", status: "failed" as const, error: "x" }] } }] as Turn[];
  const delBack = restoreOne(serialiseAsk(delTurns, []), () => ++id).turns[1] as Extract<Turn, { role: "assistant" }>;
  assert.equal(delBack.proposal?.proposal.kind, "bulk_delete");
  assert.equal(delBack.outcome?.results?.length, 2);
  const delBroken = restoreOne(serialiseAsk([turns[0]!, { ...delTurns[1]!, proposal: { ...turns[1]!.proposal, proposal: { ...del, items: [{ id: "tg_1" }] } as never } } as Turn], []), () => ++id);
  assert.equal((delBroken.turns[1] as { proposal?: unknown }).proposal, undefined);
});

test("ask store: a test chat step comes back (D-144)", () => {
  const chat = { exchanges: [{ customer: "hi", reply: "Hello!", actions: [{ tool: "refund", status: "ok" as const, pretended: true as const }], cards: [] }] };
  const turns = [
    { id: 1, role: "user" as const, text: "try it" },
    { id: 2, role: "assistant" as const, text: "It greets.", steps: [{ id: "s1", tool: "test_chat", label: "Tried", status: "done" as const, chat }] },
  ];
  let id = 0;
  const back = restoreOne(serialiseAsk(turns, []), () => ++id).turns[1] as Extract<Turn, { role: "assistant" }>;
  assert.deepEqual(back.steps?.[0]?.chat, chat);
});

test("threads: v1 migrates, upsert / merge / caps (D-134)", () => {
  const v1 = JSON.stringify({ v: 1, turns: [{ role: "user", text: "What broke  on billing?" }, { role: "assistant", text: "Stripe." }], recent: ["What broke on billing?"] });
  const migrated = restoreAsk(v1, ids(), 5);
  assert.equal(migrated.current, "t-v1");
  assert.deepEqual(migrated.threads.map((t) => [t.id, t.title, t.updatedAt, t.turns.length]), [["t-v1", "What broke on billing?", 5, 2]]);
  assert.deepEqual(migrated.recent, ["What broke on billing?"]);
  assert.equal(threadTitle([]), "New chat");
  assert.equal(threadTitle([{ role: "user", text: "x".repeat(100) }]).length, 80);

  const t = (id: string, updatedAt: number, text = id): SavedThread => ({ id, title: "", updatedAt, turns: [{ id: 1, role: "user", text }] });
  let list = upsertThread([], t("a", 1));
  list = upsertThread(list, t("b", 2));
  list = upsertThread(list, t("a", 3, "again"));
  assert.deepEqual(list.map((x) => [x.id, x.title]), [["a", "again"], ["b", "b"]]);
  assert.deepEqual(upsertThread(list, { id: "b", title: "", updatedAt: 9, turns: [] }).map((x) => x.id), ["a"]);
  for (let i = 0; i < 30; i++) list = upsertThread(list, t(`n${i}`, 10 + i));
  assert.equal(list.length, MAX_THREADS);
  assert.equal(list[0]!.id, "n29");

  const merged = mergeThreads([t("a", 5), t("b", 1)], [t("a", 3, "old"), t("c", 4), t("d", 2)], new Set(["d"]));
  assert.deepEqual(merged.map((x) => [x.id, x.turns[0]!.text]), [["a", "a"], ["c", "c"], ["b", "b"]]);

  const raw = serialiseState({ current: "a", threads: [t("a", 5), t("b", 1), { id: "e", title: "", updatedAt: 0, turns: [] }], recent: [] });
  const back = restoreAsk(raw, ids());
  assert.equal(back.current, "a");
  assert.deepEqual(back.threads.map((x) => [x.id, x.title]), [["a", "a"], ["b", "b"]]);
  // Too big: the oldest threads go, never the open one.
  const big = (id: string, at: number) => ({ id, title: "", updatedAt: at, turns: [{ id: 1, role: "user" as const, text: "z".repeat(300) }] });
  const small = restoreAsk(serialiseState({ current: "old", threads: [big("new", 3), big("mid", 2), big("old", 1)], recent: [] }, 800), ids());
  assert.deepEqual(small.threads.map((x) => x.id), ["new", "old"]);
  assert.equal(restoreAsk(JSON.stringify({ v: 2, current: "zz", threads: [{ id: "q", updatedAt: 1, turns: [{ role: "user", text: "hi" }] }], recent: [] }), ids()).current, null);
});

test("server threads: what goes up drops ids and invite links, and comes back like a stored one (D-139)", () => {
  const thread: SavedThread = {
    id: "t1",
    title: "",
    updatedAt: 42,
    turns: [
      { id: 1, role: "user", text: "Invite Ana" },
      { id: 2, role: "assistant", text: "", proposal: note, outcome: { status: "done", link: "https://desk/invite/secret" } },
      { id: 3, role: "assistant", text: "", proposal: note },
    ],
  };
  const up = serverThread(thread);
  assert.equal(up.title, "Invite Ana");
  assert.equal(up.updatedAt, 42);
  assert.equal(JSON.stringify(up).includes("secret"), false);
  assert.equal(JSON.stringify(up).includes('"id":1'), false);
  const back = readServerThread({ id: "t1", title: up.title, updatedAt: 42, turns: up.turns }, ids());
  assert.equal(back?.turns.length, 3);
  assert.deepEqual(back?.turns[2]!.role === "assistant" && back.turns[2]!.outcome, EXPIRED);
  assert.equal(readServerThread({ id: "t1", updatedAt: 1, turns: [{ role: "nope" }] }, ids()), null);
  assert.equal(readServerThread({ id: "t1", turns: [] }, ids()), null);
});
