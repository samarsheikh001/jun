import assert from "node:assert/strict";
import { test } from "node:test";
import { commandQuery, filterMentions, insertMention, matchCommands, MENTION_TOKEN, mentionQuery, mentionToken, type MentionOption } from "./ask-mentions.ts";

const opts: MentionOption[] = [
  { kind: "file", id: "tasks/refunds.md", label: "tasks/refunds.md" },
  { kind: "chat", id: "cv_1", label: "Hana Kim", detail: "open · export broke" },
  { kind: "chat", id: "cv_2", label: "Zane (Rossi)", detail: "resolved" },
  { kind: "contact", id: "ct_1", label: "Hana Kim", detail: "hana@acme.com" },
  { kind: "topic", id: "top_1", label: "Billing", detail: "4 chats" },
];

test("ask mentions: tokens, typing and filtering (D-134)", () => {
  assert.equal(mentionToken(opts[1]!), "@chat:cv_1 (Hana Kim)");
  assert.equal(mentionToken(opts[2]!), "@chat:cv_2 (Zane Rossi)");
  assert.equal(mentionToken(opts[0]!), "@file:tasks/refunds.md");
  assert.equal(mentionQuery("look at @han"), "han");
  assert.equal(mentionQuery("look at @"), "");
  assert.equal(mentionQuery("mail help@acme"), null);
  assert.equal(mentionQuery("@chat:cv_1 (Hana Kim) "), null);
  assert.deepEqual(filterMentions(opts, "han").map((o) => `${o.kind}:${o.id}`), ["chat:cv_1", "contact:ct_1"]);
  assert.deepEqual(filterMentions(opts, "export").map((o) => o.id), ["cv_1"]);
  assert.deepEqual(filterMentions(opts, "").map((o) => o.kind), ["chat", "chat", "contact", "topic", "file"]);
  assert.equal(filterMentions(opts, "", 1).filter((o) => o.kind === "chat").length, 1);
  const out = insertMention("why did @ha fail", 11, "ha", opts[1]!);
  assert.deepEqual(out, { text: "why did @chat:cv_1 (Hana Kim) fail", caret: 30 });
  assert.deepEqual([..."see @chat:cv_1 (Hana Kim) and @file:tasks/a.md.".matchAll(MENTION_TOKEN)].map((m) => m[0]), ["@chat:cv_1 (Hana Kim)", "@file:tasks/a.md"]);
});

test("ask commands: / at the start (D-134)", () => {
  assert.equal(commandQuery("/"), "");
  assert.equal(commandQuery("/err"), "err");
  assert.equal(commandQuery("/err more"), null);
  assert.equal(commandQuery("see /errors"), null);
  assert.deepEqual(matchCommands("").map((c) => c.name), ["brief", "unassigned", "errors", "knowledge-gaps", "new"]);
  assert.deepEqual(matchCommands("gap").map((c) => c.name), ["knowledge-gaps"]);
  assert.equal(matchCommands("new")[0]!.question, undefined);
  assert.deepEqual(matchCommands("ne").map((c) => c.name), ["new", "unassigned"]);
});
