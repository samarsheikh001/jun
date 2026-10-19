import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  AI_OFF_HANDOFF_REASON,
  computeMetrics,
  isAiOffHandoff,
  chatOutcome,
  groupPages,
  MAX_PAGE_SPOTS,
  startPage,
  struggleSpots,
  targetLabel,
  type PageRow,
  dayKey,
  durationStat,
  formatDuration,
  ASKED_FOR_PERSON,
  handoffReasonLabel,
  MAX_HANDOFF_REASONS,
  MAX_REASON_CHATS,
  parsePeriod,
  periodDays,
  previousPeriod,
  startOfDay,
  type ConversationFacts,
  type MetricsInput,
} from "./metrics.ts";

const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
// Monday 5 Oct 2026, 12:00 UTC.
const NOW = Date.parse("2026-10-05T12:00:00Z");

let n = 0;
function conv(at: number, facts: Partial<ConversationFacts> = {}): ConversationFacts {
  return {
    id: `cv_${++n}`,
    createdAt: at,
    resolved: false,
    firstVisitorAt: at,
    firstAiAt: null,
    firstAgentAt: null,
    firstAgentId: null,
    handoffReason: null,
    aiOffHandoff: false,
    startUrl: null,
    ...facts,
  };
}
const input = (over: Partial<MetricsInput>): MetricsInput => ({
  now: NOW,
  days: 7,
  timezone: "UTC",
  aiEnabled: true,
  conversations: [],
  ratings: [],
  replies: [],
  members: [],
  truncated: false,
  ...over,
});

test("periods: only 7, 30 and 90 days", () => {
  assert.equal(parsePeriod("7"), 7);
  assert.equal(parsePeriod("90"), 90);
  for (const bad of ["14", "", null, undefined, "7.0", " 7", "abc", "-7"]) assert.equal(parsePeriod(bad), null, String(bad));
});

test("days are calendar days in the time zone, DST included", () => {
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "UTC"), "2026-10-05");
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "Europe/Berlin"), "2026-10-06");
  assert.equal(dayKey(Date.parse("2026-10-05T02:00:00Z"), "America/New_York"), "2026-10-04");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(startOfDay("2026-10-05", "America/New_York"), Date.parse("2026-10-05T04:00:00Z")); // EDT
  // Clocks go back in Berlin on 25 Oct 2026: that day starts at UTC+2, the next at UTC+1.
  assert.equal(startOfDay("2026-10-25", "Europe/Berlin"), Date.parse("2026-10-24T22:00:00Z"));
  assert.equal(startOfDay("2026-10-26", "Europe/Berlin"), Date.parse("2026-10-25T23:00:00Z"));
  assert.equal(startOfDay("2026-10-05", "Asia/Kolkata"), Date.parse("2026-10-04T18:30:00Z"));

  const p = periodDays(NOW, 7, "UTC");
  assert.deepEqual(p.keys, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.equal(p.since, Date.parse("2026-09-29T00:00:00Z"));
  assert.equal(p.until, Date.parse("2026-10-06T00:00:00Z"));
  assert.equal(periodDays(NOW, 90, "UTC").keys.length, 90);
});

test("conversations: counted per day of the period, outside it ignored", () => {
  const r = computeMetrics(
    input({
      conversations: [
        conv(NOW),
        conv(NOW - 2 * 60 * MIN),
        conv(Date.parse("2026-09-29T00:00:00Z"), { resolved: true }), // first second of the period
        conv(Date.parse("2026-09-28T23:59:59Z")), // the day before
        conv(Date.parse("2026-10-06T00:00:00Z")), // tomorrow (clock skew)
      ],
    }),
  );
  assert.equal(r.conversations.total, 3);
  assert.equal(r.conversations.resolved, 1);
  assert.equal(r.conversations.series.length, 7);
  assert.equal(r.conversations.series[0]!.conversations, 1);
  assert.equal(r.conversations.series[6]!.conversations, 2);
  assert.equal(r.conversations.series.reduce((sum, d) => sum + d.conversations, 0), r.conversations.total);

  // The same instant falls on another day in another zone: 23:30 UTC Sunday is Monday in Berlin.
  const late = conv(Date.parse("2026-10-04T23:30:00Z"));
  assert.equal(computeMetrics(input({ conversations: [late] })).conversations.series[5]!.conversations, 1);
  assert.equal(computeMetrics(input({ conversations: [late], timezone: "Europe/Berlin" })).conversations.series[6]!.conversations, 1);
});

test("empty period: zero counts, no rates or medians", () => {
  const r = computeMetrics(input({}));
  assert.equal(r.conversations.total, 0);
  assert.equal(r.ai.resolutionRate, null);
  assert.equal(r.ai.handoffRate, null);
  assert.deepEqual(r.ai.firstResponse, { count: 0, median: null, p90: null });
  assert.deepEqual(r.team.firstResponse, { count: 0, median: null, p90: null });
  assert.equal(r.csat.score, null);
  assert.deepEqual(r.teammates, []);
});

test("AI resolution and handoff: the AI's conversations, and which it handled alone", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAiAt: t + 3 * S }), // AI alone
        conv(t, { firstAiAt: t + 5 * S }), // AI alone
        conv(t, { firstAiAt: t + 4 * S, handoffReason: "The customer asked for a person." }),
        conv(t, { handoffReason: "The customer asked for a person." }), // asked before the AI answered
        conv(t, { firstAiAt: t + 2 * S, firstAgentAt: t + MIN, firstAgentId: "u1" }), // an agent took over
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u1" }), // AI off: the team's from the start
        conv(t), // nobody answered yet
      ],
    }),
  );
  assert.equal(r.ai.conversations, 5);
  assert.equal(r.ai.resolved, 2);
  assert.equal(r.ai.handedOff, 2);
  assert.equal(r.ai.resolutionRate, 2 / 5);
  assert.equal(r.ai.handoffRate, 2 / 5);
  assert.deepEqual(r.ai.firstResponse, { count: 4, median: 3.5 * S, p90: 5 * S });
  assert.equal(r.conversations.series[6]!.aiResolved, 2);
  assert.equal(r.conversations.series[6]!.ai, 5);
});

test("change against the previous period: its own days, null without a count or from zero", () => {
  const p = previousPeriod(NOW, 7, "UTC");
  assert.equal(p.until, periodDays(NOW, 7, "UTC").since);
  assert.equal(p.since, Date.parse("2026-09-22T00:00:00Z"));
  const t = NOW - MIN;
  const two = [conv(t), conv(t), conv(t)];
  assert.equal(computeMetrics(input({ conversations: two, previousTotal: 2 })).conversations.change, 0.5);
  assert.equal(computeMetrics(input({ conversations: two, previousTotal: 0 })).conversations.change, null);
  assert.equal(computeMetrics(input({ conversations: two })).conversations.previousTotal, null);
});

test("AI off: passed to the team isn't a handoff; 'AI is off' when it's off now with no AI chats", () => {
  const t = NOW - 60 * MIN;
  const offChats = [
    conv(t, { aiOffHandoff: true, firstAgentAt: t + MIN, firstAgentId: "u1" }), // reached the AI while off
    conv(t, { handoffReason: AI_OFF_HANDOFF_REASON }), // the reason alone is enough too
    conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u1" }), // started while off: the team's
  ];
  const off = computeMetrics(input({ aiEnabled: false, conversations: offChats }));
  assert.equal(off.ai.off, true);
  assert.equal(off.ai.enabled, false);
  assert.equal(off.ai.conversations, 0);
  assert.equal(off.ai.handedOff, 0);
  assert.equal(off.ai.handoffRate, null);
  assert.deepEqual(off.ai.reasons, []);
  assert.equal(off.ai.passedWhileOff, 2);
  assert.equal(off.conversations.total, 3);

  // On now (turned on recently): real numbers, the off-time chats still aren't handoffs.
  const on = computeMetrics(input({ aiEnabled: true, conversations: offChats }));
  assert.equal(on.ai.off, false);
  assert.equal(on.ai.conversations, 0);

  // Off now, but the AI worked earlier in the period: show what it did.
  const mixed = computeMetrics(
    input({
      aiEnabled: false,
      conversations: [
        ...offChats,
        conv(t, { firstAiAt: t + 3 * S }), // AI alone
        conv(t, { firstAiAt: t + 3 * S, handoffReason: "The customer asked for a person." }),
        // Answered, then turned off before the next message: the AI's, neither resolved nor handed off.
        conv(t, { firstAiAt: t + 3 * S, aiOffHandoff: true }),
        // Passed on while off, handed back, then the AI handed off for real.
        conv(t, { firstAiAt: t + 9 * S, aiOffHandoff: true, handoffReason: "Refund request" }),
      ],
    }),
  );
  assert.equal(mixed.ai.off, false);
  assert.equal(mixed.ai.conversations, 4);
  assert.equal(mixed.ai.resolved, 1);
  assert.equal(mixed.ai.handedOff, 2);
  assert.equal(mixed.ai.passedWhileOff, 4);
  assert.deepEqual(mixed.ai.reasons.map((r) => r.reason).sort(), ["Asked for a person", "Refund request"]);
  assert.equal(isAiOffHandoff(" AI replies are turned off. "), true);
  assert.equal(isAiOffHandoff("AI error: off"), false);
  assert.equal(isAiOffHandoff(null), false);
});

test("start pages: origin + path, no query, trailing slash or ids", () => {
  assert.equal(startPage("https://app.example.com/billing?session=…"), "https://app.example.com/billing");
  assert.equal(startPage("https://app.example.com/billing/"), "https://app.example.com/billing");
  assert.equal(startPage("https://APP.example.com/billing#plans"), "https://app.example.com/billing");
  assert.equal(startPage("https://app.example.com"), "https://app.example.com/");
  assert.equal(startPage("https://app.example.com/"), "https://app.example.com/");
  assert.equal(startPage("http://localhost:5173//docs//setup/"), "http://localhost:5173/docs/setup");
  assert.equal(startPage("https://app.example.com/invoices/123"), "https://app.example.com/invoices/:id");
  assert.equal(startPage("https://app.example.com/invoices/123/edit"), "https://app.example.com/invoices/:id/edit");
  assert.equal(startPage("https://x.test/u/3f2c1a9e-8b7d-4c6e-9f10-2a3b4c5d6e7f"), "https://x.test/u/:id");
  assert.equal(startPage("https://x.test/commit/9fceb02d0ae598e9"), "https://x.test/commit/:id");
  assert.equal(startPage("https://x.test/customers/cus_8f3k2a91"), "https://x.test/customers/:id");
  assert.equal(startPage("https://x.test/share/aZ9kQ2mX7pL4tR8w"), "https://x.test/share/:id");
  assert.equal(startPage("https://x.test/cards/%5Bnumber%5D"), "https://x.test/cards/:id");
  // Words, slugs and versions stay.
  for (const path of ["/docs/getting-started", "/v2/api", "/blog/2fa-setup", "/settings/api_keys", "/deadbeef", "/how-to-reset-password-2026"]) {
    assert.equal(startPage(`https://x.test${path}`), `https://x.test${path}`, path);
  }
  for (const bad of [null, undefined, "", "/billing", "not a url", "javascript:alert(1)", "file:///etc/passwd"]) assert.equal(startPage(bad), null, String(bad));
});

test("pages where chats start: counts, chats per day and the AI's rate per page", () => {
  const at = (url: string | null, facts: Partial<ConversationFacts> = {}, t = NOW) => conv(t, { startUrl: url, ...facts });
  const ai = { firstAiAt: NOW };
  const r = computeMetrics(input({
    conversations: [
      ...Array.from({ length: 3 }, () => at("https://app.test/billing?plan=…", ai)),
      at("https://app.test/billing/", { ...ai, handoffReason: "Refund" }, NOW - 2 * DAY),
      at("https://app.test/billing", {}, NOW - 2 * DAY),
      at("https://app.test/invoices/1"),
      at("https://app.test/invoices/2"),
      at("https://docs.test/setup"),
      at(null),
      at(null),
      at("garbage"),
    ],
  }));
  assert.equal(r.pages.withPage, 8);
  assert.equal(r.pages.withoutPage, 3);
  assert.deepEqual(r.pages.rows.map((p) => [p.page, p.count]), [
    ["https://app.test/billing", 5],
    ["https://app.test/invoices/:id", 2],
    ["https://docs.test/setup", 1],
  ]);
  const billing = r.pages.rows[0]!;
  // Same days as the conversations series: 2 days ago, then today.
  assert.equal(billing.perDay.length, r.conversations.series.length);
  assert.deepEqual(billing.perDay, [0, 0, 0, 0, 2, 0, 3]);
  assert.deepEqual([billing.ai, billing.aiResolved, billing.aiResolutionRate], [4, 3, 0.75]);
  // No AI chats there: no rate.
  assert.equal(r.pages.rows[1]!.aiResolutionRate, null);
  assert.equal(r.pages.rows[1]!.children, undefined);
  assert.deepEqual(computeMetrics(input({})).pages, { rows: [], withPage: 0, withoutPage: 0 });
});

test("pages where chats start: pages under one parent path group, sums and all", () => {
  const row = (page: string, count: number, ai = 0, aiResolved = 0): PageRow => ({
    page: `https://app.test${page}`, count, perDay: [count, 1], ai, aiResolved, aiResolutionRate: ai ? aiResolved / ai : null,
  });
  const rows = groupPages([
    row("/app/settings/billing", 4, 2, 1),
    row("/app/settings/team", 2, 2, 2),
    row("/app/settings", 1),
    row("/app/home", 3),
    row("/app/inbox", 2),
    row("/pricing", 5),
    row("/docs", 1),
    row("/blog/one", 1),
  ]);
  // Root pages never group under "/", and one page under /blog stays on its own.
  assert.deepEqual(rows.map((r) => [r.page.slice(16), r.count, r.children?.length ?? 0]), [
    ["/app", 12, 3],
    ["/pricing", 5, 0],
    ["/blog/one", 1, 0],
    ["/docs", 1, 0],
  ]);
  const app = rows[0]!;
  // Deepest first: /app/settings is a group inside /app, with its own page as one of its children.
  assert.deepEqual(app.children!.map((r) => [r.page.slice(16), r.count]), [["/app/settings", 7], ["/app/home", 3], ["/app/inbox", 2]]);
  const settings = app.children![0]!;
  assert.deepEqual(settings.children!.map((r) => r.page.slice(16)), ["/app/settings/billing", "/app/settings/team", "/app/settings"]);
  assert.deepEqual(settings.perDay, [7, 3]);
  assert.deepEqual([settings.ai, settings.aiResolved, settings.aiResolutionRate], [4, 3, 0.75]);
  assert.deepEqual(app.perDay, [12, 5]);
  // A page alone under its parent joins the nearest ancestor that groups.
  const bubbled = groupPages([row("/app/settings/billing", 2), row("/app/home", 1), row("/app/inbox", 1)]);
  assert.deepEqual(bubbled.map((r) => [r.page.slice(16), r.count]), [["/app", 4]]);
  assert.deepEqual(bubbled[0]!.children!.map((r) => r.page.slice(16)), ["/app/settings/billing", "/app/home", "/app/inbox"]);
  // Different sites never group together.
  assert.equal(groupPages([{ ...row("/a/x", 1) }, { ...row("/a/y", 1), page: "https://other.test/a/y" }]).length, 2);
  assert.deepEqual(groupPages([]), []);
});

test("handoff reasons: grouped, most first, each with its share", () => {
  assert.equal(handoffReasonLabel("AI error: fetch failed (502)"), "AI error");
  assert.equal(handoffReasonLabel("Bug flagged by the AI: POST /api/billing returns 500"), "Bug flagged by the AI");
  assert.equal(handoffReasonLabel("Monthly AI reply cap (2000) reached."), "Monthly AI reply cap reached");
  assert.equal(handoffReasonLabel("  The customer asked   for a person. "), "Asked for a person");
  for (const r of ["Asked for a person", "Customer requested a person for D-128 test", "The visitor wants to talk to a human.", "User asked to speak with an agent", "customer requested a live agent", "Talk to a person"]) assert.equal(handoffReasonLabel(r), ASKED_FOR_PERSON, r);
  for (const r of ["Wants to cancel", "Customer asked for a refund", "The customer asked about personal data", "Customer requested an invoice"]) assert.notEqual(handoffReasonLabel(r), ASKED_FOR_PERSON, r);
  assert.equal(handoffReasonLabel(""), "No reason given");
  assert.equal(handoffReasonLabel("x".repeat(200)).length, 120);

  const reasons = ["Refund request", "refund request.", "Refund request", "AI error: a", "AI error: b", "Wants to cancel", "Angry", "Data deletion", "Zebra", "Asked for a person", "The customer asked for a person.", "Customer requested a person for D-128 test"];
  const r = computeMetrics(input({ conversations: reasons.map((reason) => conv(NOW, { handoffReason: reason })) }));
  assert.deepEqual(r.ai.reasons.map((x) => [x.reason, x.count]), [
    ["Asked for a person", 3],
    ["Refund request", 3],
    ["AI error", 2],
    ["Angry", 1],
    ["Data deletion", 1],
    ["Wants to cancel", 1],
    ["Zebra", 1],
  ]);
  assert.equal(r.ai.reasons[0]!.share, 3 / 12);
  assert.equal(r.ai.handedOff, 12);

  // Capped at MAX_HANDOFF_REASONS.
  const many = computeMetrics(input({ conversations: Array.from({ length: MAX_HANDOFF_REASONS + 5 }, (_, i) => conv(NOW, { handoffReason: `Reason ${i}` })) }));
  assert.equal(many.ai.reasons.length, MAX_HANDOFF_REASONS);
});

test("handoff reasons: topics, chats and the time from handoff to the team's reply (D-126)", () => {
  const refund = { handoffReason: "Refund needs approval", firstAiAt: NOW + S };
  const r = computeMetrics(input({
    conversations: [
      conv(NOW - 3 * MIN, { ...refund, id: "a", topicId: "tp_r", topicName: "Refunds", handoffAt: NOW, firstAgentAt: NOW + 4 * MIN }),
      conv(NOW - 2 * MIN, { ...refund, id: "b", topicId: "tp_r", topicName: "Refunds", handoffAt: NOW, firstAgentAt: NOW + 2 * MIN }),
      conv(NOW - 1 * MIN, { ...refund, id: "c", topicId: "tp_b", topicName: "Billing", handoffAt: NOW }),
      // A teammate replied before the handoff: replied, but not a reply to it.
      conv(NOW - 4 * MIN, { ...refund, id: "d", handoffAt: NOW, firstAgentAt: NOW - MIN }),
      // Older callers without handoffAt: no time.
      conv(NOW - 5 * MIN, { ...refund, id: "e", firstAgentAt: NOW + MIN, topicId: "tp_x", topicName: "Accounts" }),
      conv(NOW, { handoffReason: "Asked for a person", id: "f", handoffAt: NOW, firstAgentAt: NOW + 10 * MIN }),
    ],
  }));
  const x = r.ai.reasons[0]!;
  assert.equal(x.reason, "Refund needs approval");
  assert.equal(x.count, 5);
  assert.equal(x.labeled, 4);
  assert.deepEqual(x.topics, [{ name: "Refunds", count: 2 }, { name: "Accounts", count: 1 }]);
  assert.equal(x.replyMedian, 3 * MIN);
  assert.deepEqual(x.chats.map((c) => c.id), ["c", "b", "a", "d", "e"], "newest first");
  assert.deepEqual(x.chats.find((c) => c.id === "d"), { id: "d", createdAt: NOW - 4 * MIN, topic: null, replied: true, replyAfter: null });
  assert.equal(x.chats.find((c) => c.id === "c")!.replied, false);
  assert.deepEqual(r.ai.reasons[1]!.topics, []);
  // Over every reason: 2m, 4m, 10m.
  assert.equal(r.ai.handoffReply.count, 3);
  assert.equal(r.ai.handoffReply.median, 4 * MIN);

  const many = computeMetrics(input({ conversations: Array.from({ length: MAX_REASON_CHATS + 3 }, (_, i) => conv(NOW - i * S, { handoffReason: "Angry" })) }));
  assert.equal(many.ai.reasons[0]!.chats.length, MAX_REASON_CHATS);
  assert.equal(many.ai.reasons[0]!.count, MAX_REASON_CHATS + 3);
});

test("first response: first visitor message to first public agent reply", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAgentAt: t + 30 * S, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u2" }),
        conv(t, { firstAgentAt: t + 10 * MIN, firstAgentId: "u1" }),
        conv(t, { firstVisitorAt: null, firstAgentAt: t, firstAgentId: "u1" }), // no visitor message: no time
        conv(t, { firstVisitorAt: t + MIN, firstAgentAt: t, firstAgentId: "u1" }), // reply before the question: ignored
      ],
    }),
  );
  assert.equal(r.team.answered, 3);
  assert.deepEqual(r.team.firstResponse, { count: 3, median: 2 * MIN, p90: 10 * MIN });
  assert.equal(durationStat([5, 1, 3, 2]).median, 2.5);
  assert.equal(durationStat(Array.from({ length: 10 }, (_, i) => i + 1)).p90, 9);
  assert.equal(durationStat([7]).p90, 7);
  assert.equal(durationStat([Number.NaN, -1]).count, 0);
});

test("CSAT: ratings given in the period, score, latest bad comments", () => {
  const ratings = [
    { conversationId: "c1", rating: "good" as const, comment: "Great", createdAt: NOW - 5 * MIN },
    { conversationId: "c2", rating: "bad" as const, comment: "  Slow  ", createdAt: NOW - 4 * MIN },
    { conversationId: "c3", rating: "bad" as const, comment: null, createdAt: NOW - 3 * MIN },
    { conversationId: "c4", rating: "good" as const, comment: null, createdAt: NOW - 30 * 24 * 60 * MIN }, // too old
    ...Array.from({ length: 6 }, (_, i) => ({ conversationId: `b${i}`, rating: "bad" as const, comment: `bad ${i}`, createdAt: NOW - 60 * MIN - i * MIN })),
  ];
  const r = computeMetrics(input({ ratings }));
  assert.equal(r.csat.good, 1);
  assert.equal(r.csat.bad, 8);
  assert.equal(r.csat.score, 1 / 9);
  assert.deepEqual(
    r.csat.badComments.map((c) => [c.conversationId, c.comment]),
    [["c2", "Slow"], ["b0", "bad 0"], ["b1", "bad 1"], ["b2", "bad 2"], ["b3", "bad 3"]],
    "newest first, only with a comment, at most five",
  );
});

test("teammates: replies, conversations, and their first responses", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      members: [
        { userId: "u1", name: "Ann" },
        { userId: "u2", name: "Bo" },
        { userId: "u3", name: "Cy" },
      ],
      replies: [
        { userId: "u2", replies: 9, conversations: 4 },
        { userId: "u1", replies: 3, conversations: 2 },
        { userId: "gone", replies: 1, conversations: 1 },
      ],
      conversations: [
        conv(t, { firstAgentAt: t + MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 3 * MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 20 * S, firstAgentId: "u2" }),
      ],
    }),
  );
  assert.deepEqual(
    r.teammates.map((m) => [m.name, m.replies, m.conversations, m.firstResponse.median]),
    [["Bo", 9, 4, 20 * S], ["Ann", 3, 2, 2 * MIN], ["Former teammate", 1, 1, null], ["Cy", 0, 0, null]],
  );
});

test("the cap is passed through", () => {
  assert.equal(computeMetrics(input({ truncated: true })).truncated, true);
});

test("durations read like a person wrote them", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45 * S), "45s");
  assert.equal(formatDuration(59.6 * S), "1m");
  assert.equal(formatDuration(3 * MIN + 10 * S), "3m");
  assert.equal(formatDuration(59 * MIN + 40 * S), "1h");
  assert.equal(formatDuration(80 * MIN), "1h 20m");
  assert.equal(formatDuration(2 * 24 * 60 * MIN + 4 * 60 * MIN), "2d 4h");
  assert.equal(formatDuration(3 * 24 * 60 * MIN), "3d");
  assert.equal(formatDuration(-5), "0s");
});

test("topics (A-02): counts, share of labelled chats, AI resolution per topic", () => {
  const billing = { topicId: "top_b", topicName: "Billing" };
  const login = { topicId: "top_l", topicName: "Login" };
  const r = computeMetrics(
    input({
      conversations: [
        conv(NOW, { ...billing, firstAiAt: NOW + S }), // AI resolved
        conv(NOW, { ...billing, firstAiAt: NOW + S, handoffReason: "The customer asked for a person." }),
        conv(NOW, { ...billing }), // team only: not an AI conversation
        conv(NOW, { ...login, firstAiAt: NOW + S }),
        conv(NOW, { topicId: "top_x", topicName: null }), // topic deleted meanwhile: unlabeled
        conv(NOW), // not labelled yet
        conv(NOW, { firstVisitorAt: null }), // no visitor message: never labelled, not counted
        conv(NOW - 30 * 24 * 60 * MIN, { ...login }), // outside the period
      ],
    }),
  );
  assert.deepEqual(r.topics, {
    list: [
      { id: "top_b", name: "Billing", count: 3, share: 3 / 4, aiResolutionRate: 1 / 2, aiResolved: 1, ai: 2, handedOff: 1 },
      { id: "top_l", name: "Login", count: 1, share: 1 / 4, aiResolutionRate: 1, aiResolved: 1, ai: 1, handedOff: 0 },
    ],
    labeled: 4,
    unlabeled: 2,
  });
  assert.deepEqual(computeMetrics(input({})).topics, { list: [], labeled: 0, unlabeled: 0 });
  // Ties sort by name; a topic with no AI conversations has no rate.
  const tie = computeMetrics(input({ conversations: [conv(NOW, login), conv(NOW, billing)] }));
  assert.deepEqual(tie.topics.list.map((t) => [t.name, t.aiResolutionRate]), [["Billing", null], ["Login", null]]);
});

// A-08: where visitors who chatted struggled.
test("struggleSpots: by page and element, once per conversation, overlapping snapshots merged", () => {
  const ev = (events: object[]) => JSON.stringify(events);
  const exportRage = { t: 3, kind: "rage_click", count: 4, target: { tag: "button", id: "export", text: "Export CSV" } };
  const out = struggleSpots([
    // One chat, two messages: the second snapshot repeats the first trail.
    { conversationId: "a", pageUrl: "https://app.acme.dev/home", events: ev([{ t: 1, kind: "navigation", url: "/reports/123" }, exportRage]) },
    { conversationId: "a", pageUrl: "https://app.acme.dev/reports/123", events: ev([{ t: 1, kind: "navigation", url: "/reports/123" }, exportRage, { t: 9, kind: "dead_click", target: { tag: "a", text: "Help" } }]) },
    // Another chat, same button on another report: grouped as /reports/:id.
    { conversationId: "b", pageUrl: "https://app.acme.dev/reports/77", events: ev([{ ...exportRage, t: 5 }, { t: 6, kind: "stuck", url: "/import", seconds: 180, issue: "error" }]) },
    { conversationId: "c", pageUrl: "https://app.acme.dev/", events: ev([{ t: 1, kind: "error", message: "x" }]) },
    { conversationId: "d", pageUrl: null, events: "not json" },
  ]);
  assert.equal(out.conversations, 2);
  // One card per page, worst first; without facts nothing is known about the outcome.
  assert.deepEqual(out.pages.map((p) => [p.page, p.conversations, p.known, p.toPerson]), [
    ["https://app.acme.dev/reports/:id", 2, 0, 0],
    ["https://app.acme.dev/import", 1, 0, 0],
  ]);
  assert.deepEqual(out.pages[0]!.spots, [
    { kind: "rage_click", page: "https://app.acme.dev/reports/:id", target: 'button#export "Export CSV"', label: "Export CSV", conversations: 2, chats: ["a", "b"] },
    { kind: "dead_click", page: "https://app.acme.dev/reports/:id", target: 'a "Help"', label: "Help", conversations: 1, chats: ["a"] },
  ]);
  assert.deepEqual(out.pages[0]!.chats, [
    { id: "a", createdAt: null, outcome: null, kinds: ["rage_click", "dead_click"] },
    { id: "b", createdAt: null, outcome: null, kinds: ["rage_click"] },
  ]);
  assert.deepEqual(out.pages[1]!.spots, [{ kind: "stuck", page: "https://app.acme.dev/import", target: null, label: null, conversations: 1, chats: ["b"] }]);
  assert.deepEqual(struggleSpots([]), { pages: [], conversations: 0 });
});

test("struggle cards: how many troubled chats went to a person, newest first", () => {
  const ev = (url: string, kind = "rage_click") => JSON.stringify([{ t: 1, kind, target: { tag: "button", text: "Save" }, url }]);
  const snap = (conversationId: string, events = ev("/x")) => ({ conversationId, pageUrl: "https://app.test/settings", events });
  const chats = [
    conv(NOW - 5 * MIN, { id: "handed", firstAiAt: NOW, handoffReason: "Wants a person" }),
    conv(NOW - 4 * MIN, { id: "agent", firstAgentAt: NOW }),
    conv(NOW - 3 * MIN, { id: "aiOff", aiOffHandoff: true }),
    conv(NOW - 2 * MIN, { id: "ai", firstAiAt: NOW }),
    conv(NOW - 1 * MIN, { id: "none" }),
  ];
  const r = computeMetrics(input({ conversations: chats, snapshots: [...chats.map((c) => snap(c.id)), snap("gone")] }));
  const card = r.struggles.pages[0]!;
  assert.deepEqual([card.conversations, card.known, card.toPerson], [6, 5, 3]);
  assert.deepEqual(card.chats.map((c) => [c.id, c.outcome]), [["none", "none"], ["ai", "ai"], ["aiOff", "person"], ["agent", "person"], ["handed", "person"], ["gone", null]]);
  assert.equal(card.spots[0]!.label, "Save");
  assert.equal(chatOutcome(conv(NOW, { firstAiAt: NOW })), "ai");
  assert.equal(targetLabel({ tag: "button", id: "save" }), "#save");
  assert.equal(targetLabel({ tag: "div", label: "Close" }), "Close");
  assert.equal(targetLabel(undefined), "an element");
});

test("struggle cards: at most MAX_PAGE_SPOTS chips, the rest counted", () => {
  const events = JSON.stringify(Array.from({ length: MAX_PAGE_SPOTS + 2 }, (_, i) => ({ t: i, kind: "dead_click", target: { tag: "a", text: `L${i}` } })));
  const out = struggleSpots([{ conversationId: "a", pageUrl: "https://app.test/", events }]);
  assert.equal(out.pages[0]!.spots.length, MAX_PAGE_SPOTS);
  assert.equal(out.pages[0]!.moreSpots, 2);
});
