import assert from "node:assert/strict";
import { test } from "node:test";
import type { TopicCount } from "../../shared/metrics.ts";
import { insightText, topicInsight } from "./topic-insight.ts";

/** Topics from counts and (ai, aiResolved) pairs; shares of their total, sorted as computeMetrics does. */
function topics(rows: [string, number, number, number][]): { list: TopicCount[]; labeled: number } {
  const labeled = rows.reduce((s, r) => s + r[1], 0);
  const list = rows
    .map(([name, count, ai, aiResolved]) => ({ id: `top_${name}`, name, count, share: count / labeled, aiResolutionRate: ai ? aiResolved / ai : null, aiResolved, ai, handedOff: ai - aiResolved }))
    .sort((a, b) => b.count - a.count);
  return { list, labeled };
}

test("topicInsight: nothing without topics", () => {
  assert.equal(topicInsight([], 0, true), null);
});

test("topicInsight: one topic", () => {
  const t = topics([["Billing", 12, 10, 8]]);
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "All 12 labelled chats are about Billing. The AI resolves 80% of the Billing chats it handles.");
  const one = topics([["Billing", 1, 0, 0]]);
  assert.equal(insightText(topicInsight(one.list, one.labeled, true)!), "The one labelled chat is about Billing.");
});

test("topicInsight: a leading topic, then the weakest busy one", () => {
  const t = topics([["Billing", 50, 40, 30], ["Refunds", 20, 10, 2], ["Login", 30, 2, 0]]);
  const parts = topicInsight(t.list, t.labeled, true)!;
  // Login has only 2 AI chats: too few to judge.
  assert.equal(insightText(parts), "Billing alone is 50% of labelled chats. The AI resolves only 20% of the Refunds chats it handles.");
  assert.deepEqual(parts[0], { topic: "Billing", id: "top_Billing", lead: true });
});

test("topicInsight: a busy topic the AI never resolves", () => {
  const t = topics([["Billing", 50, 10, 6], ["Bugs", 30, 4, 0], ["Login", 20, 0, 0]]);
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "Billing alone is 50% of labelled chats. The AI resolves none of the Bugs chats it handles.");
});

test("topicInsight: the top two or three make up the share", () => {
  const t = topics([["Billing", 22, 0, 0], ["Login", 19, 0, 0], ["A", 15, 0, 0], ["B", 15, 0, 0], ["C", 15, 0, 0], ["D", 14, 0, 0]]);
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "Billing and Login make up 41% of labelled chats.");
  const three = topics([["A", 14, 0, 0], ["B", 13, 0, 0], ["C", 13, 0, 0], ...[1, 2, 3, 4, 5, 6].map((i): [string, number, number, number] => [`T${i}`, 10, 0, 0])]);
  assert.equal(insightText(topicInsight(three.list, three.labeled, true)!), "A, B and C make up 40% of labelled chats.");
});

test("topicInsight: spread out", () => {
  const t = topics(Array.from({ length: 10 }, (_, i): [string, number, number, number] => [`T${i}`, 10, 0, 0]));
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "Chats spread over 10 topics; the biggest, T0, is 10%.");
});

test("topicInsight: every busy topic does well; AI off says nothing about the AI", () => {
  const t = topics([["Billing", 50, 10, 9], ["Login", 50, 10, 7]]);
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "Billing and Login make up 100% of labelled chats. The AI resolves at least 70% of the chats it handles in every busy topic.");
  assert.equal(insightText(topicInsight(t.list, t.labeled, false)!), "Billing and Login make up 100% of labelled chats.");
});

test("topicInsight: no AI chats leaves the AI out", () => {
  const t = topics([["Billing", 60, 0, 0], ["Login", 40, 0, 0]]);
  assert.equal(insightText(topicInsight(t.list, t.labeled, true)!), "Billing alone is 60% of labelled chats.");
});
