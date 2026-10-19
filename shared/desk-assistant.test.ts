import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentFileLink,
  applyAgentFileEdit,
  proposalCard,
  proposalForModel,
  proposalRisk,
  settingChanges,
  settingText,
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
  assert.equal(outcomeTitle({ kind: "note", conversationId: "cv_1", body: "x" }, {}, { status: "cancelled", detail: "expired" }), "Expired");
  assert.match(outcomeLine({ status: "cancelled", detail: "expired" }), /expired/);
  assert.equal(outcomeTitle({ kind: "issue", conversationId: "cv_1" }, {}, { status: "failed", detail: "no tracker" }), "Didn't work: no tracker");
});

test("assistant: D-133 proposals for the rest of the desk are read and checked", () => {
  assert.deepEqual(readProposal("propose_handling", { conversationId: "cv_1", handling: "ai" }, "u"), { kind: "handling", conversationId: "cv_1", handling: "ai" });
  assert.throws(() => readProposal("propose_handling", { conversationId: "cv_1", handling: "bot" }, "u"), /handling/);
  assert.deepEqual(readProposal("propose_invite_visitor", { sessionId: "s_abc123", body: " Need a hand? " }, "u"), { kind: "invite_visitor", sessionId: "s_abc123", body: "Need a hand?" });
  assert.throws(() => readProposal("propose_contact", { contactId: "ct_1", email: "nope" }, "u"), /email/);
  assert.throws(() => readProposal("propose_contact", { contactId: "ct_1" }, "u"), /name or an email/);
  // Agent files: allowed paths only; desk.yaml goes through the settings proposals.
  assert.throws(() => readProposal("propose_agent_file", { path: "desk.yaml", action: "write", text: "x" }, "u"), /propose_desk_settings/);
  assert.throws(() => readProposal("propose_agent_file", { path: "../x.md", action: "write", text: "x" }, "u"), /path must be/);
  assert.throws(() => readProposal("propose_agent_file", { path: "instructions.md", action: "delete" }, "u"), /can't be deleted/);
  assert.throws(() => readProposal("propose_agent_file", { path: "tasks/refunds.md", action: "edit" }, "u"), /edits is required/);
  const edit = readProposal("propose_agent_file", { path: "instructions.md", action: "edit", edits: [{ find: "  Be kind.", replace: "  Be kind and brief." }] }, "u");
  assert.deepEqual(edit, { kind: "agent_file", path: "instructions.md", op: "edit", before: null, after: null, edit: { action: "edit", edits: [{ find: "  Be kind.", replace: "  Be kind and brief." }] } });
  // Settings: only known keys; ChatGPT never.
  assert.deepEqual(readProposal("propose_desk_settings", { changes: { greeting: "Hi!" } }, "u"), { kind: "desk_settings", patch: { greeting: "Hi!" }, changes: [] });
  assert.throws(() => readProposal("propose_desk_settings", { changes: { logoKey: "x" } }, "u"), /isn't a setting/);
  assert.throws(() => readProposal("propose_desk_settings", { changes: {} }, "u"), /at least one/);
  assert.throws(() => readProposal("propose_ai_settings", { provider: "chatgpt" }, "u"), /sign-in/);
  assert.deepEqual(readProposal("propose_ai_settings", { enabled: "false", model: "default" }, "u"), { kind: "ai_settings", patch: { enabled: false, model: null }, changes: [] });
  assert.throws(() => readProposal("propose_ai_settings", {}, "u"), /Say which/);
  // Knowledge, inbox setup, team.
  assert.deepEqual(readProposal("propose_knowledge", { kind: "remove_page", sourceId: "src_1", documentId: "doc_1" }, "u"), { kind: "knowledge_remove_page", sourceId: "src_1", documentId: "doc_1" });
  assert.throws(() => readProposal("propose_knowledge", { kind: "edit", sourceId: "src_1", exclude: ["blog"] }, "u"), /paths like/);
  assert.deepEqual(readProposal("propose_saved_reply", { op: "edit", id: "sr_1", title: "Refunds" }, "u"), { kind: "saved_reply_edit", replyId: "sr_1", title: "Refunds", body: "", changes: [] });
  assert.throws(() => readProposal("propose_saved_reply", { op: "create", title: "x" }, "u"), /body is required/);
  assert.deepEqual(readProposal("propose_tag", { op: "rename", id: "tag_1", name: "#billing" }, "u"), { kind: "tag_rename", tagId: "tag_1", name: "billing" });
  assert.throws(() => readProposal("propose_topic", { op: "merge", id: "tp_1", into: "tp_1" }, "u"), /itself/);
  assert.deepEqual(readProposal("propose_topic", { op: "label" }, "u"), { kind: "topic_label" });
  assert.deepEqual(readProposal("propose_team", { op: "invite", role: "agent" }, "u"), { kind: "team_invite", role: "agent" });
  assert.throws(() => readProposal("propose_team", { op: "invite", role: "owner" }, "u"), /role/);
  assert.throws(() => readProposal("propose_team", { op: "remove", userId: "usr_me" }, "usr_me"), /yourself/);
  assert.deepEqual(readProposal("propose_notifications", { sound: false, bogus: true }, "u"), { kind: "notifications", patch: { sound: false }, changes: [] });
  assert.deepEqual(readProposal("propose_email", { op: "test" }, "u"), { kind: "email_test", to: null });
  assert.deepEqual(readProposal("propose_identity_off", {}, "u"), { kind: "identity_off" });
});

test("assistant: an agent file edit becomes the file's new text (D-133)", () => {
  const file = "# Persona\n\nBe kind.\nBe kind.\nKeep it short.\n";
  assert.equal(applyAgentFileEdit("instructions.md", file, { action: "edit", edits: [{ find: "Keep it short.", replace: "Keep it short and plain." }] }), "# Persona\n\nBe kind.\nBe kind.\nKeep it short and plain.\n");
  assert.throws(() => applyAgentFileEdit("instructions.md", file, { action: "edit", edits: [{ find: "Be kind.", replace: "x" }] }), /more than once/);
  assert.throws(() => applyAgentFileEdit("instructions.md", file, { action: "edit", edits: [{ find: "Be rude.", replace: "x" }] }), /isn't in/);
  assert.equal(applyAgentFileEdit("instructions.md", file, { action: "append", text: "Sign off with the team's name." }), `${file}Sign off with the team's name.\n`);
  assert.equal(applyAgentFileEdit("tasks/refunds.md", null, { action: "write", text: "---\ndescription: x\n---\nSteps" }), "---\ndescription: x\n---\nSteps\n");
  assert.equal(applyAgentFileEdit("tasks/refunds.md", "x\n", { action: "delete" }), null);
  assert.throws(() => applyAgentFileEdit("tasks/refunds.md", null, { action: "delete" }), /no tasks\/refunds.md/);
  assert.throws(() => applyAgentFileEdit("instructions.md", file, { action: "write", text: file }), /doesn't change/);
  assert.throws(() => applyAgentFileEdit("tasks/new.md", null, { action: "edit", edits: [{ find: "a", replace: "b" }] }), /use action write/);
});

test("assistant: settings changes, risk and the card's words (D-133)", () => {
  assert.equal(settingText(undefined), "default");
  assert.equal(settingText(false), "off");
  assert.equal(settingText(["acme.com", "*.acme.com"]), "acme.com, *.acme.com");
  assert.equal(settingText({ mode: "manual", capacity: 0 }), '{"mode":"manual","capacity":0}');
  assert.deepEqual(settingChanges({ greeting: "Greeting", sound: "Sounds" }, { greeting: "Hi", sound: true }, { greeting: "Hello", sound: true }, ["greeting", "sound"]), [{ key: "greeting", label: "Greeting", before: "Hi", after: "Hello" }]);
  const changes = [{ key: "greeting", label: "Greeting", before: "Hi", after: "Hello" }];
  assert.equal(proposalSummary({ kind: "desk_settings", patch: { greeting: "Hello" }, changes }, {}), "Change the chat widget's greeting");
  assert.equal(proposalSummary({ kind: "agent_file", path: "instructions.md", op: "edit", before: "a", after: "b" }, {}), "Change instructions.md in the support agent");
  assert.equal(proposalSummary({ kind: "tag_delete", tagId: "t" }, { target: "old", detail: "3 chats" }), "Delete the tag “old” from every chat (3 chats)");
  for (const p of [{ kind: "tag_delete", tagId: "t" }, { kind: "knowledge_remove", sourceId: "s" }, { kind: "team_remove", userId: "u" }, { kind: "identity_off" }, { kind: "topic_merge", topicId: "a", into: "b" }] as const) assert.equal(proposalRisk(p)?.tone, "destructive", p.kind);
  assert.equal(proposalRisk({ kind: "invite_visitor", sessionId: "s_1", body: "Hi" })?.tone, "external");
  assert.equal(proposalRisk({ kind: "email_test", to: null })?.line, "This sends a real email.");
  assert.equal(proposalRisk({ kind: "email_settings", patch: { enabled: true }, changes: [] })?.tone, "external");
  assert.equal(proposalRisk({ kind: "email_settings", patch: { fromName: "Acme" }, changes: [] }), null);
  assert.equal(proposalRisk({ kind: "agent_file", path: "tasks/x.md", op: "delete", before: "x", after: null }), null, "versioned: History undoes it");
  assert.deepEqual(proposalCard({ kind: "agent_file", path: "tasks/x.md", op: "create", before: null, after: "x" }), { title: "Add tasks/x.md?", confirm: "Add file" });
  assert.deepEqual(proposalCard({ kind: "team_remove", userId: "u" }), { title: "Remove this teammate?", confirm: "Remove teammate" });
  // The model's own call in the history leaves the file texts out.
  assert.deepEqual(proposalForModel({ kind: "agent_file", path: "instructions.md", op: "edit", before: "long", after: "longer" }), { kind: "agent_file", path: "instructions.md", op: "edit" });
  const done = { status: "done" as const, detail: "version 12; it's live now" };
  assert.equal(outcomeTitle({ kind: "agent_file", path: "instructions.md", op: "edit", before: "a", after: "b" }, {}, done), "Saved · instructions.md · version 12");
  assert.equal(outcomeTitle({ kind: "team_invite", role: "agent" }, {}, { status: "done", detail: "made", link: "https://x/invite/abc" }), "Invite link made · agent");
  assert.equal(outcomeTitle({ kind: "saved_reply_delete", replyId: "sr_1" }, { target: "Refunds" }, { status: "done" }), "Saved reply deleted · Refunds");
  // An invite link never reaches the model.
  assert.doesNotMatch(outcomeLine({ status: "done", detail: "made an invite link for an agent", link: "https://x/invite/secret" }), /secret/);
});

test("assistant: bulk proposals (D-134)", async () => {
  const { bulkOutcome, bulkSingle, bulkVerb, runPool } = await import("./desk-assistant.ts");
  const p = readProposal("propose_bulk", { op: "status", status: "resolved", conversationIds: ["cv_1aa", "cv_2bb", "cv_1aa"] }, "usr_me");
  assert.deepEqual(p, { kind: "bulk", op: "status", conversationIds: ["cv_1aa", "cv_2bb"], items: [], status: "resolved" });
  assert.throws(() => readProposal("propose_bulk", { op: "status", status: "resolved", conversationIds: ["cv_1aa"] }, "usr_me"), /at least 2/);
  assert.throws(() => readProposal("propose_bulk", { op: "status", status: "resolved", conversationIds: Array.from({ length: 51 }, (_, i) => `cv_${i}xx`) }, "usr_me"), /At most 50/);
  assert.throws(() => readProposal("propose_bulk", { op: "status", status: "resolved", conversationIds: ["cv_1aa", "x y"] }, "usr_me"), /conversation ids/);
  assert.throws(() => readProposal("propose_bulk", { op: "delete", conversationIds: ["cv_1aa", "cv_2bb"] }, "usr_me"), /op must be/);
  assert.equal((readProposal("propose_bulk", { op: "assign", assignee: "me", conversationIds: ["cv_1aa", "cv_2bb"] }, "usr_me") as { assigneeId: string }).assigneeId, "usr_me");
  assert.throws(() => readProposal("propose_bulk", { op: "tags", conversationIds: ["cv_1aa", "cv_2bb"] }, "usr_me"), /tags to add/);
  const bulk = { ...(p as Extract<typeof p, { kind: "bulk" }>), items: [{ conversationId: "cv_1aa", customer: "Hana Kim", before: "open", after: "resolved" }, { conversationId: "cv_2bb", customer: "Zane", before: "pending", after: "resolved" }] };
  assert.equal(bulkVerb(bulk, 2), "Resolve 2 chats");
  assert.equal(proposalCard(bulk).confirm, "Resolve 2 chats");
  assert.equal(proposalSummary(bulk, {}), "Resolve 2 chats");
  assert.deepEqual(bulkSingle(bulk, "cv_2bb"), { kind: "status", conversationId: "cv_2bb", status: "resolved" });
  assert.deepEqual(proposalForModel(bulk), { kind: "bulk", op: "status", status: "resolved", conversationIds: ["cv_1aa", "cv_2bb"] });
  const out = bulkOutcome(bulk.items, [{ conversationId: "cv_1aa", status: "done" }, { conversationId: "cv_2bb", status: "failed", error: "Not found" }]);
  assert.equal(out.status, "done");
  assert.equal(out.detail, "1 done, 1 failed: Zane (Not found)");
  assert.equal(outcomeTitle(bulk, {}, out), "Resolved · 1 chat · 1 failed");
  assert.equal(bulkOutcome(bulk.items, [{ conversationId: "cv_1aa", status: "skipped" }, { conversationId: "cv_2bb", status: "failed", error: "x" }]).status, "failed");
  // At most 3 at once, every item once.
  let running = 0, peak = 0;
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("assistant: next questions are cleaned (D-134)", async () => {
  const { readNextQuestions, nextQuestionsInput } = await import("./desk-assistant.ts");
  assert.deepEqual(readNextQuestions('1. "Which chats were about billing?"\n- **Who handles export errors?**\n\nWhat broke on /pricing?\nSee [this](/inbox/cv_1)\nWhich chats were about billing\nA fourth one here?', "what broke on /pricing?"), [
    "Which chats were about billing?",
    "Who handles export errors?",
    "A fourth one here?",
  ]);
  assert.deepEqual(readNextQuestions(""), []);
  assert.deepEqual(readNextQuestions("x".repeat(90)), []);
  assert.match(nextQuestionsInput("q", "a", ["Searched conversations"]), /What it looked at: Searched conversations/);
});

test("assistant: Reports' numbers as step charts (D-134)", async () => {
  const { stepCharts } = await import("./desk-assistant.ts");
  const days = stepCharts("report_metrics", JSON.stringify({ days: 7, conversations: { total: 9, changePercent: -10 }, perDay: [{ day: "2026-10-19", chats: 4, ai: 3, aiResolved: 2 }, { day: "2026-10-20", chats: 5, ai: 5, aiResolved: 1 }, { day: "bad" }] }));
  assert.deepEqual(days, [{ kind: "days", days: 7, total: 9, change: -10, series: [{ day: "2026-10-19", chats: 4, ai: 3, aiResolved: 2 }, { day: "2026-10-20", chats: 5, ai: 5, aiResolved: 1 }] }]);
  assert.equal(stepCharts("report_metrics", { perDay: [{ day: "2026-10-19", chats: 1 }] }), undefined);
  const ranked = stepCharts("topics_and_handoffs", { topics: [{ name: "Billing", chats: 4, aiChats: 3, aiResolved: 1, handedOff: 2, link: "/inbox?topic=top_1" }, { name: "Empty", chats: 0 }, { name: "Evil", chats: 1, link: "https://evil.example" }], handoffReasons: [{ reason: "Asked for a person", chats: 3 }] });
  assert.equal(ranked?.length, 2);
  assert.deepEqual(ranked?.[0], { kind: "ranked", title: "Topics", rows: [{ label: "Billing", value: 4, href: "/inbox?topic=top_1", detail: "3 with the AI · 1 resolved by it · 2 handed off" }, { label: "Evil", value: 1 }] });
  assert.deepEqual(ranked?.[1], { kind: "ranked", title: "Handoff reasons", rows: [{ label: "Asked for a person", value: 3 }] });
  assert.equal(stepCharts("topics_and_handoffs", { topics: [], handoffReasons: [] }), undefined);
  assert.equal(stepCharts("search_conversations", { perDay: [] }), undefined);
});
