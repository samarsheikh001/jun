import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics, handoffReasonLabel, type HandoffReason } from "../../shared/metrics.ts";
import { handoffInsight, handoffNextStep, reasonTopicsLine } from "./handoff-reasons.ts";
import { insightText } from "./topic-insight.ts";

// The reasons the desk and the AI really write, through the same grouping Reports uses.
const kind = (raw: string) => handoffNextStep(handoffReasonLabel(raw))?.kind ?? null;

test("next step: by how reasons are written", () => {
  // The Conversation DO's own reasons.
  assert.equal(kind("AI error: fetch failed (502)"), "ai-settings");
  assert.equal(kind("AI unavailable: 401 Unauthorized"), "ai-settings");
  assert.equal(kind("The AI gave an empty reply."), "ai-settings");
  assert.equal(kind("Monthly AI reply cap (2000) reached."), "ai-settings");
  assert.equal(handoffNextStep("AI error")?.path, "/settings/ai");
  assert.equal(kind("Bug flagged by the AI: POST /api/billing returns 500"), "bug");
  assert.equal(handoffNextStep("Bug flagged by the AI")?.path, undefined, "the issue is filed from a chat");
  assert.equal(kind("The AI couldn't answer from the knowledge base."), "knowledge");
  assert.equal(handoffNextStep("Not in the knowledge")?.path, "/knowledge");
  // The model's own words.
  assert.equal(kind("Bug needs engineering"), "bug");
  assert.equal(kind("No docs on SSO setup"), "knowledge");
  assert.equal(kind("Couldn't find the export limits"), "knowledge");
  assert.equal(kind("Pricing for teams is undocumented"), "knowledge");
  // The handoff working as configured: none.
  assert.equal(kind("The customer asked for a person."), null);
  assert.equal(kind("Asked for a person"), null);
  assert.equal(kind("Refund needs approval"), null);
  assert.equal(kind("The customer wants to: Cancel the subscription"), null);
  assert.equal(kind("The AI has answered 8 times without resolving it."), null);
  assert.equal(kind("Frustrated customer"), null);
});

const reason = (name: string, count: number, handedOff: number): HandoffReason =>
  ({ reason: name, count, share: count / handedOff, topics: [], labeled: 0, replyMedian: null, chats: [] });

test("insight: the top reason, the runner-up without a majority, a knowledge gap", () => {
  assert.equal(handoffInsight([], 0), null);
  assert.equal(insightText(handoffInsight([reason("Asked for a person", 4, 4)], 4)!), "All 4 handoffs had one reason: Asked for a person.");
  assert.equal(insightText(handoffInsight([reason("Asked for a person", 1, 1)], 1)!), "The one handoff's reason: Asked for a person.");
  assert.equal(
    insightText(handoffInsight([reason("Refund needs approval", 6, 10), reason("Asked for a person", 4, 10)], 10)!),
    "Refund needs approval is behind most handoffs (60%).",
  );
  assert.equal(
    insightText(handoffInsight([reason("Not in the knowledge", 10, 31), reason("Asked for a person", 8, 31), reason("Bug needs engineering", 7, 31)], 31)!),
    "Not in the knowledge leads with 32% of handoffs, then Asked for a person (26%).",
  );
  assert.equal(
    insightText(handoffInsight([reason("Asked for a person", 4, 10), reason("Refunds", 3, 10), reason("Not in the knowledge", 3, 10)], 10)!),
    "Asked for a person leads with 40% of handoffs, then Refunds (30%). 30% were questions the knowledge didn't answer.",
  );
  assert.equal(insightText(handoffInsight([reason("A", 2, 4), reason("B", 2, 4)], 4)!), "A and B tie at 50% of handoffs each.");
  // A gap already named isn't repeated.
  assert.equal(
    insightText(handoffInsight([reason("Asked for a person", 3, 9), reason("Not in the knowledge", 3, 9), reason("Bug", 3, 9)], 9)!),
    "Asked for a person and Not in the knowledge tie at 33% of handoffs each.",
  );
  const parts = handoffInsight([reason("A", 3, 4), reason("B", 1, 4)], 4)!;
  assert.deepEqual(parts[0], { topic: "A", id: "A", lead: true });
});

test("topics line: mostly when the top topics cover half, else often; none without labels", () => {
  assert.equal(reasonTopicsLine({ topics: [], labeled: 0 }), null);
  assert.equal(reasonTopicsLine({ topics: [{ name: "Refunds", count: 3 }, { name: "Billing", count: 1 }], labeled: 5 }), "mostly Refunds, Billing");
  assert.equal(reasonTopicsLine({ topics: [{ name: "Refunds", count: 1 }, { name: "Billing", count: 1 }], labeled: 6 }), "often Refunds, Billing");
  // From computeMetrics' own shape.
  const at = Date.parse("2026-10-05T11:00:00Z");
  const r = computeMetrics({
    now: at + 3_600_000, days: 7, timezone: "UTC", aiEnabled: true, ratings: [], replies: [], members: [], truncated: false,
    conversations: [{ id: "a", createdAt: at, resolved: false, firstVisitorAt: null, firstAiAt: null, firstAgentAt: null, firstAgentId: null, handoffReason: "Refund", aiOffHandoff: false, startUrl: null, topicId: "t", topicName: "Refunds" }],
  });
  assert.equal(reasonTopicsLine(r.ai.reasons[0]!), "mostly Refunds");
});
