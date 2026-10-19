import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedNumbers,
  briefPoints,
  briefWindows,
  checkSentence,
  freshBrief,
  isKnowledgeGap,
  issueSignature,
  numbersIn,
  plainBrief,
  readBriefAnswer,
  type BriefInput,
} from "./home-brief.ts";
import type { ConversationFacts } from "./metrics.ts";

const H = 3_600_000;
const D = 24 * H;
// Tuesday 20 Oct 2026, 15:00 UTC.
const NOW = Date.parse("2026-10-20T15:00:00Z");
let n = 0;
const conv = (at: number, f: Partial<ConversationFacts> = {}): ConversationFacts => ({
  id: `cv_${++n}`,
  createdAt: at,
  resolved: false,
  firstVisitorAt: at,
  firstAiAt: at + 2000,
  firstAgentAt: null,
  firstAgentId: null,
  handoffReason: null,
  handoffAt: null,
  aiOffHandoff: false,
  startUrl: "https://app.acme.com/home",
  topicId: null,
  topicName: null,
  ...f,
});
const base = (over: Partial<BriefInput> = {}): BriefInput => ({ now: NOW, timezone: "UTC", aiEnabled: true, userId: "usr_me", facts: [], ratings: [], struggles: [], issues: [], waiting: [], members: [], ...over });

test("brief: the window is yesterday and today, compared with the week before", () => {
  const w = briefWindows(NOW, "UTC");
  assert.equal(w.day, "2026-10-20");
  assert.equal(w.since, Date.parse("2026-10-19T00:00:00Z"));
  assert.equal(w.until, Date.parse("2026-10-21T00:00:00Z"));
  assert.equal(w.previousSince, Date.parse("2026-10-17T00:00:00Z"));
  assert.equal(w.baselineSince, Date.parse("2026-10-12T00:00:00Z"));
});

test("brief: since yesterday counts chats, the AI's share and the top reasons", () => {
  const points = briefPoints(base({
    facts: [
      conv(NOW - 2 * H),
      conv(NOW - 3 * H, { handoffReason: "Customer asked for a person", handoffAt: NOW - 3 * H }),
      conv(NOW - 20 * H, { handoffReason: "Customer asked for a person", handoffAt: NOW - 20 * H }),
      conv(NOW - 30 * H, { firstAiAt: null }),
      conv(NOW - 3 * D), // the two days before
    ],
  }));
  const chats = points.find((p) => p.id === "chats")!;
  assert.equal(chats.plain, "4 chats since yesterday, up from 1 the two days before. The AI took 3: it resolved 1 on its own and handed 2 to the team.");
  assert.equal(chats.link?.path, "/dashboard");
  assert.equal(chats.chats.length, 4);
  const reasons = points.find((p) => p.id === "reasons")!;
  assert.equal(reasons.plain, "Top handoff reason: “Customer asked for a person” (2).");
  assert.equal(reasons.chats.length, 2);
});

test("brief: what needs you: unassigned, your chats waiting, bad ratings; else all clear", () => {
  const points = briefPoints(base({
    waiting: [
      { id: "cv_a", contact: "Ana", assigneeId: null, lastMessageAt: NOW - 3 * H, lastAuthor: "visitor" },
      { id: "cv_b", contact: "Bo", assigneeId: null, lastMessageAt: NOW - H, lastAuthor: "agent" },
      { id: "cv_c", contact: "Cy", assigneeId: "usr_me", lastMessageAt: NOW - 40 * 60_000, lastAuthor: "visitor" },
      { id: "cv_d", contact: "Di", assigneeId: "usr_me", lastMessageAt: NOW - 10 * 60_000, lastAuthor: "agent" },
      { id: "cv_e", contact: "Ed", assigneeId: "usr_other", lastMessageAt: NOW - H, lastAuthor: "visitor" },
    ],
    ratings: [{ conversationId: "cv_x", rating: "bad", comment: "Export still broken", createdAt: NOW - H }, { conversationId: "cv_y", rating: "bad", comment: null, createdAt: NOW - 5 * D }],
  }));
  const unassigned = points.find((p) => p.id === "unassigned")!;
  assert.equal(unassigned.plain, "2 chats with the team have nobody assigned; the longest has waited 3h.");
  assert.deepEqual(unassigned.chats, ["cv_a", "cv_b"], "longest waiting first");
  assert.equal(unassigned.link?.path, "/inbox?assignee=unassigned");
  const mine = points.find((p) => p.id === "mine")!;
  assert.deepEqual(mine.chats, ["cv_c"], "only yours where the customer wrote last");
  const bad = points.find((p) => p.id === "bad_csat")!;
  assert.equal(bad.plain, "1 bad rating since yesterday, one saying “Export still broken”.");
  assert.ok(!points.some((p) => p.id === "clear"));
  assert.ok(briefPoints(base()).some((p) => p.id === "clear" && p.tone === "ok"));
});

test("brief: what's unusual: topic and page spikes, new struggle spots and errors, knowledge gaps", () => {
  const billing = { topicId: "tp_bill", topicName: "Billing" };
  const facts = [
    ...[1, 2, 3, 4].map((h) => conv(NOW - h * H, { ...billing, startUrl: "https://app.acme.com/billing/inv_8f3k2a9" })),
    conv(NOW - 4 * D, billing),
    // Knowledge gaps on one topic, twice this week.
    conv(NOW - 2 * D, { topicId: "tp_exp", topicName: "Exports", handoffReason: "The AI couldn't answer from the knowledge base.", handoffAt: NOW - 2 * D }),
    conv(NOW - 5 * D, { topicId: "tp_exp", topicName: "Exports", handoffReason: "No information about CSV exports", handoffAt: NOW - 5 * D }),
  ];
  const rage = (id: string, t: number, text: string) => ({ conversationId: id, pageUrl: "https://app.acme.com/reports", events: JSON.stringify([{ t, kind: "rage_click", target: { tag: "button", text } }]) });
  const err = (id: string, t: number, message: string) => ({ conversationId: id, pageUrl: null, events: JSON.stringify([{ t, kind: "error", message }]) });
  const points = briefPoints(base({
    facts,
    struggles: [rage(facts[0]!.id, NOW - H, "Export"), rage(facts[4]!.id, NOW - 4 * D, "Save")],
    issues: [err(facts[0]!.id, NOW - H, "TypeError: x is undefined"), err(facts[1]!.id, NOW - 2 * H, "Old error"), err(facts[4]!.id, NOW - 4 * D, "Old error")],
  }));
  const ids = points.filter((p) => p.section === "unusual").map((p) => p.id);
  assert.ok(ids.includes("topic:tp_bill"), ids.join());
  const topic = points.find((p) => p.id === "topic:tp_bill")!;
  assert.equal(topic.plain, "More chats about “Billing”: 4 since yesterday, against 1 in the whole week before.");
  assert.equal(topic.link?.path, "/inbox?topic=tp_bill");
  assert.ok(points.some((p) => p.id.startsWith("page:") && p.plain.includes("/billing/:id")));
  const spot = points.find((p) => p.id.startsWith("struggle:"))!;
  assert.match(spot.plain, /rage clicks on “Export” at \/reports/);
  const error = points.filter((p) => p.id.startsWith("error:"));
  assert.equal(error.length, 1, "the error seen the week before isn't new");
  assert.match(error[0]!.plain, /TypeError: x is undefined/);
  const gap = points.find((p) => p.id.startsWith("gap:"))!;
  assert.match(gap.plain, /couldn't answer 2 chats about “Exports”/);
  assert.ok(!points.some((p) => p.id === "quiet"));
  assert.ok(briefPoints(base()).some((p) => p.id === "quiet"));
});

test("brief: signatures and knowledge gaps", () => {
  assert.equal(issueSignature({ t: 1, kind: "network", method: "POST", url: "/api/invoices/8812/pay", status: 500 }), "POST /api/invoices/:id/pay failed (500)");
  assert.equal(issueSignature({ t: 1, kind: "network", url: "/x", status: 200 }), null);
  assert.equal(issueSignature({ t: 1, kind: "rage_click" }), null);
  assert.equal(isKnowledgeGap("The AI couldn't answer from the knowledge base."), true);
  assert.equal(isKnowledgeGap("Customer asked for a person"), false);
});

test("brief: the AI's sentences must use only the point's numbers", () => {
  assert.deepEqual(numbersIn("1,234 chats, 45% and 3h 20m"), [1234, 45, 3, 20]);
  const points = briefPoints(base({ facts: [conv(NOW - H), conv(NOW - 2 * H)] }));
  const chats = points.find((p) => p.id === "chats")!;
  const allowed = allowedNumbers(chats);
  assert.equal(checkSentence("Two quiet days: 2 chats, both resolved by the AI.", allowed), "Two quiet days: 2 chats, both resolved by the AI.");
  assert.equal(checkSentence("You had 5 chats.", allowed), null, "an invented number");
  assert.equal(checkSentence("See [Reports](/dashboard).", allowed), null, "no links from the model");
  const meta = { day: "2026-10-20", timezone: "UTC", generatedAt: NOW };
  const brief = readBriefAnswer('```json\n{"headline":"A calm start with 2 chats.","points":{"chats":"2 chats came in and the AI handled 9 of them."}}\n```', points, meta);
  assert.equal(brief, null, "no sentence passed: unusable");
  const ok = readBriefAnswer(JSON.stringify({ headline: "A calm start: 2 chats.", points: { chats: "2 chats came in; the AI resolved 2 on its own." } }), points, meta)!;
  assert.equal(ok.source, "ai");
  assert.equal(ok.headline, "A calm start: 2 chats.");
  assert.equal(ok.points.find((p) => p.id === "chats")!.text, "2 chats came in; the AI resolved 2 on its own.");
  assert.equal(ok.points.find((p) => p.id === "clear")!.text, ok.points.find((p) => p.id === "clear")!.plain, "points it skipped keep the plain words");
  assert.equal(readBriefAnswer("not json", points, meta), null);
});

test("brief: plain brief and the cache's day", () => {
  const points = briefPoints(base({ facts: [conv(NOW - H)] }));
  const brief = plainBrief(points, { day: "2026-10-20", timezone: "UTC", generatedAt: NOW });
  assert.equal(brief.source, "plain");
  assert.equal(brief.headline, "1 chat since yesterday, nothing waiting on a person.");
  const json = JSON.stringify(brief);
  assert.ok(freshBrief(json, "2026-10-20", "UTC"));
  assert.equal(freshBrief(json, "2026-10-21", "UTC"), null);
  assert.equal(freshBrief(json, "2026-10-20", "Europe/Berlin"), null);
  assert.equal(freshBrief("{", "2026-10-20", "UTC"), null);
});
