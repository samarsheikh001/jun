import assert from "node:assert/strict";
import { test } from "node:test";
import { stepTable } from "../../shared/desk-assistant.ts";
import { nextSort, RECORD_COLUMNS, recordHref, sortRecords } from "./records.ts";

test("records table: tool results → rows, sorting (D-134)", () => {
  const t = stepTable("search_conversations", JSON.stringify({ total: 30, conversations: [
    { id: "cv_1", customer: "Zane", status: "open", assignee: null, topic: "Billing", lastMessage: "2026-10-20T14:03Z" },
    { id: "cv_2", customer: "ana", status: "resolved", assignee: "Sam", topic: null, lastMessage: "2026-10-19T09:00Z" },
    { nope: true },
  ] }));
  assert.equal(t?.kind, "chats");
  assert.equal(t?.kind === "chats" && t.total, 30);
  assert.equal(t?.rows.length, 2);
  assert.equal(t?.rows[0]!.last, Date.parse("2026-10-20T14:03Z"));
  assert.equal(stepTable("search_conversations", { conversations: [] }), undefined);
  assert.equal(stepTable("read_conversation", { conversations: [{ id: "x" }] }), undefined);
  assert.equal(stepTable("find_contacts", { people: [{ id: "ct_1", name: null, email: "a@b.co", company: { id: "co", name: "Acme" }, chats: 2, lastSeen: null }] })?.rows[0]!.name, "a@b.co");
  assert.equal(stepTable("find_contacts", { companies: [{ id: "co_1", name: "Acme", people: 3, chats: 4 }] })?.kind, "companies");
  assert.equal(stepTable("find_contacts", { people: Array.from({ length: 40 }, (_, i) => ({ id: `ct_${i}` })) })?.rows.length, 25);

  const rows = t!.rows;
  assert.deepEqual(sortRecords(rows, { key: "name", dir: "asc" }).map((r) => r.id), ["cv_2", "cv_1"]);
  assert.deepEqual(sortRecords(rows, { key: "assignee", dir: "asc" }).map((r) => r.id), ["cv_2", "cv_1"]);
  assert.deepEqual(sortRecords(rows, { key: "assignee", dir: "desc" }).map((r) => r.id), ["cv_2", "cv_1"]);
  assert.deepEqual(sortRecords(rows, { key: "last", dir: "asc" }).map((r) => r.id), ["cv_2", "cv_1"]);
  const time = RECORD_COLUMNS.chats.find((c) => c.key === "last")!;
  assert.deepEqual(nextSort(null, time), { key: "last", dir: "desc" });
  assert.deepEqual(nextSort({ key: "last", dir: "desc" }, time), { key: "last", dir: "asc" });
  assert.equal(nextSort({ key: "last", dir: "asc" }, time), null);
  assert.equal(recordHref("companies", "co_1"), "/contacts/companies/co_1");
});
