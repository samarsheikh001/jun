import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanThread, isThreadId, MAX_THREAD_BYTES, overCap, planSync } from "./ask-threads.ts";

test("ask threads: a stored thread drops local ids and invite links (D-133, D-139)", () => {
  const r = cleanThread({ title: "  Who  is\nwaiting? ", updatedAt: 5, turns: [{ id: 3, role: "user", text: "hi" }, { id: 4, role: "assistant", text: "Done", outcome: { status: "done", link: "https://desk/invite/abc", detail: "x" } }] }, 1000);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.title, "Who is waiting?");
  assert.equal(r.updatedAt, 5);
  assert.equal(r.turns.includes("invite"), false);
  assert.deepEqual(JSON.parse(r.turns), [{ role: "user", text: "hi" }, { role: "assistant", text: "Done", outcome: { status: "done", detail: "x" } }]);
});

test("ask threads: bad, oversized and future-dated bodies", () => {
  assert.equal(cleanThread(null).ok, false);
  assert.equal(cleanThread({ updatedAt: 1, turns: [] }).ok, false);
  assert.equal(cleanThread({ updatedAt: "1", turns: [{ role: "user", text: "a" }] }).ok, false);
  assert.equal(cleanThread({ updatedAt: 1, turns: [{ role: "user" }] }).ok, false);
  const big = cleanThread({ updatedAt: 1, turns: [{ role: "user", text: "x".repeat(MAX_THREAD_BYTES) }] });
  assert.equal(big.ok === false && big.code, "too_large");
  const many = cleanThread({ updatedAt: 1, turns: Array.from({ length: 31 }, () => ({ role: "user", text: "a" })) });
  assert.equal(many.ok === false && many.code, "too_large");
  const future = cleanThread({ updatedAt: 10_000_000, turns: [{ role: "user", text: "a" }] }, 1000);
  assert.equal(future.ok && future.updatedAt, 61_000);
  const untitled = cleanThread({ updatedAt: 1, turns: [{ role: "user", text: "a" }] });
  assert.equal(untitled.ok && untitled.title, "New chat");
});

test("ask threads: ids and the cap keep the newest 20", () => {
  assert.equal(isThreadId("tlz4k2abc"), true);
  assert.equal(isThreadId("t-v1"), true);
  assert.equal(isThreadId("x1"), false);
  assert.equal(isThreadId("t/../x"), false);
  const list = Array.from({ length: 23 }, (_, i) => ({ id: `t${i}`, title: "", updatedAt: i }));
  assert.deepEqual(overCap(list), ["t2", "t1", "t0"]);
  assert.deepEqual(overCap(list.slice(0, 5)), []);
});

test("ask threads: sync plan by updatedAt, tombstones and this tab's deletes", () => {
  const local = [
    { id: "ta", title: "", updatedAt: 10 }, // same on both
    { id: "tb", title: "", updatedAt: 30 }, // newer here
    { id: "tc", title: "", updatedAt: 5 }, // older here
    { id: "td", title: "", updatedAt: 7 }, // only here (a first sync uploads it)
    { id: "te", title: "", updatedAt: 8 }, // deleted on the server later
    { id: "tf", title: "", updatedAt: 20 }, // changed here after the server deleted it
  ];
  const server = {
    threads: [
      { id: "ta", title: "", updatedAt: 10 },
      { id: "tb", title: "", updatedAt: 20 },
      { id: "tc", title: "", updatedAt: 9 },
      { id: "tg", title: "", updatedAt: 3 }, // only there
      { id: "th", title: "", updatedAt: 3 }, // only there, deleted in this tab
    ],
    deleted: [
      { id: "te", deletedAt: 9 },
      { id: "tf", deletedAt: 15 },
    ],
  };
  assert.deepEqual(planSync(local, server, new Set(["th"])), { download: ["tc", "tg"], upload: ["tb", "td", "tf"], remove: ["te"] });
});

test("recent questions: merged across browsers, newest first, once each, ≤ 5 (D-144)", async () => {
  const { mergeRecent, readRecent, MAX_RECENT } = await import("./ask-threads.ts");
  const here = [{ q: "What broke?", at: 50 }, { q: "Refunds", at: 10 }];
  const there = [{ q: "what  broke?", at: 40 }, { q: "Export errors", at: 30 }, { q: "Refunds ", at: 60 }];
  assert.deepEqual(mergeRecent(here, there), [{ q: "Refunds", at: 60 }, { q: "What broke?", at: 50 }, { q: "Export errors", at: 30 }]);
  const many = Array.from({ length: 8 }, (_, i) => ({ q: `Q${i}`, at: i }));
  assert.deepEqual(mergeRecent(many).map((r) => r.q), ["Q7", "Q6", "Q5", "Q4", "Q3"]);
  assert.equal(mergeRecent(many).length, MAX_RECENT);
  assert.deepEqual(mergeRecent([{ q: "  ", at: 9 }]), []);
  // D-132's bare strings keep their order; bad items are dropped; a clock far ahead is pulled back.
  assert.deepEqual(readRecent(["b", 3, "a"], 10_000), [{ q: "b", at: 9000 }, { q: "a", at: 7000 }]);
  assert.deepEqual(readRecent([{ q: "x", at: 99_999_999 }, { q: "y" }, null], 1000), [{ q: "x", at: 61_000 }]);
  assert.deepEqual(readRecent("nope"), []);
});
