import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { mergeConversations } from "./conversation-list.ts";

const c = (id: string, lastSeq: number, lastMessageAt: number, visitorReadSeq = 0) => ({ id, lastSeq, lastMessageAt, visitorReadSeq }) as ConversationSummary;

test("mergeConversations keeps the newer copy of each chat, newest first", () => {
  const prev = [c("a", 5, 50), c("b", 3, 30)];
  const next = [c("b", 4, 40), c("a", 4, 45), c("n", 1, 60)];
  const merged = mergeConversations(prev, next);
  assert.deepEqual(merged.map((x) => [x.id, x.lastSeq]), [["n", 1], ["a", 5], ["b", 4]]);
});

test("mergeConversations: a tie takes the fetched copy, with the higher read seq; chats only on screen stay", () => {
  const merged = mergeConversations([c("a", 4, 40, 2), c("z", 1, 10)], [c("a", 4, 40, 4)]);
  assert.equal(merged.find((x) => x.id === "a")!.visitorReadSeq, 4);
  assert.deepEqual(merged.map((x) => x.id), ["a", "z"]);
  // The thread marked it read while a slower fetch was out: the read stays.
  assert.equal(mergeConversations([c("a", 4, 40, 4)], [c("a", 4, 40, 2)])[0]!.visitorReadSeq, 4);
});
