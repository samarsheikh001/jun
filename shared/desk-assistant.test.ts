import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentFileLink,
  AssistantInputError,
  callInput,
  capResult,
  isDeskLink,
  newCallId,
  nextTags,
  outcomeLine,
  proposalSummary,
  readAgentFilePath,
  readAskTurns,
  readConversationSearch,
  readDays,
  readProposal,
  outcomeTitle,
  stepInput,
  stepLabel,
  stepResult,
  takeTurn,
} from "./desk-assistant.ts";

test("assistant: tool inputs are checked and defaulted", () => {
  assert.deepEqual(readConversationSearch({}), { status: "all", withErrors: false, limit: 10 });
  assert.deepEqual(readConversationSearch('{"text":" export ","status":"open","limit":99,"withErrors":true,"days":3}'), { status: "open", withErrors: true, limit: 20, text: "export", days: 3 });
  assert.throws(() => readConversationSearch({ status: "closed" }), AssistantInputError);
  assert.throws(() => readConversationSearch({ since: "yesterday" }), /date like/);
  assert.throws(() => readConversationSearch({ assignee: "'; DROP TABLE" }), /assignee/);
  assert.equal(readConversationSearch({ assignee: "usr_abc123" }).assignee, "usr_abc123");
  assert.deepEqual(readDays({}), { days: 7 });
  assert.deepEqual(readDays({ days: "30" }), { days: 30 });
  assert.throws(() => readDays({ days: 14 }), /7, 30 or 90/);
  assert.deepEqual(readAgentFilePath({ path: "tasks/refunds.md" }), { path: "tasks/refunds.md" });
  for (const path of ["../secrets", "/etc/passwd", "a b.md"]) assert.throws(() => readAgentFilePath({ path }), AssistantInputError);
  assert.deepEqual(callInput("not json"), {});
  assert.deepEqual(callInput([1]), {});
});

test("assistant: results are capped as valid JSON, cutting the longest list", () => {
  const big = { total: 500, conversations: Array.from({ length: 500 }, (_, i) => ({ id: `cv_${i}`, preview: "x".repeat(80) })) };
  const out = capResult(big, 4000);
  assert.ok(out.length <= 4000);
  const parsed = JSON.parse(out) as { total: number; truncated: boolean; conversations: unknown[] };
  assert.equal(parsed.total, 500);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.conversations.length > 10 && parsed.conversations.length < 500);
  assert.equal(capResult({ a: 1 }), '{"a":1}');
  // Nothing to cut: still valid JSON under the cap.
  const text = capResult({ text: "y".repeat(10_000) }, 500);
  assert.ok(text.length <= 500);
  assert.equal((JSON.parse(text) as { truncated: boolean }).truncated, true);
});

test("assistant: proposals are read into the shapes the page runs", () => {
  assert.deepEqual(readProposal("propose_assign", { conversationId: "cv_1", assignee: "me" }, "usr_me"), { kind: "assign", conversationId: "cv_1", assigneeId: "usr_me" });
  assert.deepEqual(readProposal("propose_assign", { conversationId: "cv_1", assignee: "nobody" }, "usr_me"), { kind: "assign", conversationId: "cv_1", assigneeId: null });
  assert.deepEqual(readProposal("propose_status", { conversationId: "cv_1", status: "resolved" }, "u"), { kind: "status", conversationId: "cv_1", status: "resolved" });
  assert.throws(() => readProposal("propose_status", { conversationId: "cv_1", status: "deleted" }, "u"), /status/);
  assert.deepEqual(readProposal("propose_tags", { conversationId: "cv_1", add: ["billing", " export "], remove: "old" }, "u"), { kind: "tags", conversationId: "cv_1", add: ["billing", "export"], remove: ["old"] });
  assert.throws(() => readProposal("propose_tags", { conversationId: "cv_1" }, "u"), /add or remove/);
  assert.throws(() => readProposal("propose_tags", { conversationId: "cv_1", add: ["x".repeat(41)] }, "u"));
  assert.deepEqual(readProposal("propose_note", { conversationId: "cv_1", body: " Looks like the export bug " }, "u"), { kind: "note", conversationId: "cv_1", body: "Looks like the export bug" });
  assert.throws(() => readProposal("propose_note", { conversationId: "cv_1", body: "  " }, "u"), /body is required/);
  assert.throws(() => readProposal("propose_note", { conversationId: "../x", body: "hi" }, "u"), /id from a tool result/);
  assert.deepEqual(readProposal("propose_reply_draft", { conversationId: "cv_1", body: "Hi!" }, "u"), { kind: "reply_draft", conversationId: "cv_1", body: "Hi!" });
  assert.deepEqual(readProposal("propose_issue", { conversationId: "cv_1" }, "u"), { kind: "issue", conversationId: "cv_1" });
  assert.deepEqual(readProposal("propose_knowledge", { kind: "website", url: "https://docs.acme.com/export" }, "u"), { kind: "knowledge_website", url: "https://docs.acme.com/export", maxPages: 1 });
  assert.throws(() => readProposal("propose_knowledge", { kind: "website", url: "javascript:alert(1)" }, "u"), /https/);
  assert.deepEqual(readProposal("propose_knowledge", { kind: "text", title: "Exports", body: "CSV only." }, "u"), { kind: "knowledge_text", title: "Exports", body: "CSV only." });
});

test("assistant: a card's summary says what Confirm does", () => {
  assert.equal(proposalSummary({ kind: "assign", conversationId: "cv_1", assigneeId: "u" }, { conversation: "Ana", assignee: "Sam" }), "Assign the chat with Ana to Sam");
  assert.equal(proposalSummary({ kind: "status", conversationId: "cv_1", status: "open" }, {}), "Reopen this chat");
  assert.equal(proposalSummary({ kind: "tags", conversationId: "cv_1", add: ["bug"], remove: ["new"] }, { conversation: "Ana" }), "Add “bug” and remove “new” on the chat with Ana");
  assert.match(proposalSummary({ kind: "note", conversationId: "cv_1", body: "x" }, {}), /only your team sees it/);
  assert.match(proposalSummary({ kind: "reply_draft", conversationId: "cv_1", body: "x" }, {}), /you send it/);
});

test("assistant: tags after a proposal keep the first spelling", () => {
  assert.deepEqual(nextTags(["Billing", "new"], ["billing", "bug"], ["NEW"]), ["Billing", "bug"]);
  assert.deepEqual(nextTags([], [], []), []);
});

test("assistant: the chat history is checked; proposals keep their outcome", () => {
  const proposal = { callId: "abc123xyz", tool: "propose_note", proposal: { kind: "note", conversationId: "cv_1", body: "x" }, labels: { conversation: "Ana" }, summary: "Add a note" };
  const turns = readAskTurns([
    { role: "assistant", text: "stray first turn" },
    { role: "user", text: "Add a note" },
    { role: "assistant", text: "Here it is.", proposal, outcome: { status: "done" } },
    { role: "assistant", text: "", proposal: { ...proposal, callId: "BAD" } },
    { role: "system", text: "ignored" },
    { role: "user", text: "Thanks" },
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0]!.role, "user");
  assert.deepEqual(turns[1], { role: "assistant", text: "Here it is.", proposal: { ...proposal, labels: {} }, outcome: { status: "done" } });
  assert.throws(() => readAskTurns([]), /Ask something/);
  assert.throws(() => readAskTurns("x"), /list/);
  assert.match(outcomeLine({ status: "cancelled" }), /Cancel/);
  assert.match(outcomeLine({ status: "failed", detail: "Only admins" }), /Only admins/);
  assert.match(newCallId(), /^[a-z0-9]{9}$/);
});

test("assistant: per-member rate limit with a burst and a daily cap", () => {
  const limits = [{ windowMs: 1000, max: 2 }, { windowMs: 10_000, max: 3 }];
  let times: number[] = [];
  for (const at of [0, 100]) {
    const r = takeTurn(times, at, limits);
    assert.equal(r.ok, true);
    times = r.times;
  }
  const blocked = takeTurn(times, 200, limits);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, 800);
  const next = takeTurn(times, 1100, limits);
  assert.equal(next.ok, true);
  const daily = takeTurn(next.times, 2500, limits);
  assert.equal(daily.ok, false);
  assert.equal(daily.retryAfterMs, 7500);
  assert.equal(takeTurn(next.times, 20_000, limits).times.length, 1, "old times are dropped");
});

test("assistant: desk links and step lines", () => {
  for (const ok of ["/inbox/cv_1", "/inbox?topic=tp_1", "/contacts/companies/co_1", "/dashboard", "/agent/tasks/refunds"]) assert.equal(isDeskLink(ok), true, ok);
  for (const bad of ["//evil.test", "/api/conversations", "/inbox/<x>", "javascript:alert(1)", "/w/acme/inbox"]) assert.equal(isDeskLink(bad), false, bad);
  assert.equal(agentFileLink("tasks/refunds.md"), "/agent/tasks/refunds");
  assert.equal(agentFileLink("widgets/order.widget"), "/agent/widgets/order");
  assert.equal(agentFileLink("instructions.md"), "/agent");
  assert.equal(stepLabel("search_conversations", { text: "export" }, false), "Searching conversations “export”…");
  assert.equal(stepLabel("search_conversations", {}, true), "Searched conversations");
});

test("assistant: a step's input and result as short lines (D-129)", () => {
  assert.equal(stepInput({ text: "export", limit: 10, status: undefined, tag: "" }), "text: export, limit: 10");
  assert.equal(stepInput({}), undefined);
  assert.equal(stepResult(JSON.stringify({ total: 23, conversations: new Array(10).fill({}) })), "10 of 23 conversations");
  assert.equal(stepResult({ total: 1, conversations: [{}] }), "1 conversation");
  assert.equal(stepResult({ link: "/knowledge", hits: [{}, {}, {}] }), "3 matches");
  assert.equal(stepResult({ openChats: [{}, {}], truncated: true }), "2 open chats+");
  assert.equal(stepResult('{"error":"No conversation cv_1 in this workspace."}'), "No conversation cv_1 in this workspace.");
  assert.equal(stepResult({ path: "instructions.md", text: "…" }), undefined);
  assert.equal(stepResult({ customer: "Zane Rossi", tags: ["export-issue"], messages: [{}, {}] }), "Zane Rossi · 2 messages");
  assert.equal(stepResult({ events: [{}] }), "1 event");
  assert.equal(stepResult("not json"), undefined);
});

test("assistant: a settled card's line (D-129)", () => {
  const done = { status: "done" } as const;
  assert.equal(outcomeTitle({ kind: "tags", conversationId: "cv_1", add: ["export-issue"], remove: [] }, {}, done), "Tagged · export-issue");
  assert.equal(outcomeTitle({ kind: "assign", conversationId: "cv_1", assigneeId: "usr_1" }, { assignee: "you" }, done), "Assigned · you");
  assert.equal(outcomeTitle({ kind: "status", conversationId: "cv_1", status: "resolved" }, {}, done), "Resolved");
  assert.equal(outcomeTitle({ kind: "note", conversationId: "cv_1", body: "x" }, {}, { status: "cancelled" }), "Cancelled");
  assert.equal(outcomeTitle({ kind: "note", conversationId: "cv_1", body: "x" }, {}, { status: "cancelled", detail: "not confirmed" }), "Not confirmed");
  assert.equal(outcomeTitle({ kind: "issue", conversationId: "cv_1" }, {}, { status: "failed", detail: "no tracker" }), "Didn't work: no tracker");
});
