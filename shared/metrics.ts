// A-01: core metrics. Pure (Intl only): the Worker fetches one row of facts per conversation,
// the CSAT ratings and per-teammate reply counts for the period, and this turns them into the
// report the dashboard shows. Days are calendar days in the viewer's time zone (DST-safe).

import { describeTarget, type DebugEvent, type DebugTarget } from "./debug.ts";

export const METRIC_PERIODS = [7, 30, 90] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];
/** Most conversations a report reads; beyond this it covers the newest ones and says so. */
export const MAX_METRIC_CONVERSATIONS = 20_000;

/** One conversation started in the period, as aggregated in SQL. Times are epoch ms. */
export interface ConversationFacts {
  id: string;
  createdAt: number;
  resolved: boolean;
  /** First message from the visitor (null for a conversation without one). */
  firstVisitorAt: number | null;
  /** First public AI answer. */
  firstAiAt: number | null;
  /** First public agent reply at or after the first visitor message (internal notes don't count). */
  firstAgentAt: number | null;
  firstAgentId: string | null;
  /** Reason on the first public handoff by the AI (never AI_OFF_HANDOFF_REASON), or null. */
  handoffReason: string | null;
  /** D-126: when that handoff notice was written. Optional for older callers. */
  handoffAt?: number | null;
  /** It was passed to the team because AI replies were off: not the AI handing off. */
  aiOffHandoff: boolean;
  /** Page of the conversation's first debug snapshot, sent with the visitor's first message (A-06). */
  startUrl: string | null;
  /** A-02: the conversation's topic label (null while unlabeled). Optional for older callers. */
  topicId?: string | null;
  topicName?: string | null;
}

export interface RatingRow {
  conversationId: string;
  rating: "good" | "bad";
  comment: string | null;
  createdAt: number;
}

/** Public agent replies sent in the period, per author (aggregated in SQL). */
export interface ReplyRow {
  userId: string;
  replies: number;
  conversations: number;
}

export interface MetricsInput {
  now: number;
  days: number;
  timezone: string;
  /** The workspace's AI replies are on right now. */
  aiEnabled: boolean;
  conversations: ConversationFacts[];
  ratings: RatingRow[];
  replies: ReplyRow[];
  members: { userId: string; name: string }[];
  /** The conversation rows were capped at MAX_METRIC_CONVERSATIONS. */
  truncated: boolean;
  /** Conversations started in the period before this one (same length), for the change; optional for older callers. */
  previousTotal?: number | null;
  /** A-08: the debug snapshots of the period's conversations (their events as stored JSON). */
  snapshots?: SnapshotEvents[];
}

/** A-08: one debug snapshot's events (JSON text, as stored) and the page it was taken on. */
export interface SnapshotEvents {
  conversationId: string;
  pageUrl: string | null;
  events: string | null;
}

export type StruggleKind = "rage_click" | "dead_click" | "stuck";
/** A-08: a page (grouped like startPage) and, for clicks, what was clicked; counted once per conversation. */
export interface StruggleSpot {
  kind: StruggleKind;
  page: string;
  /** The element as describeTarget writes it (null for stuck). */
  target: string | null;
  /** A short name for it ("Save"): its text, else its aria-label, #id, name, role or tag (null for stuck). */
  label: string | null;
  conversations: number;
  /** The chats that hit it, newest first (at most MAX_STRUGGLE_CHATS). */
  chats: string[];
}
/** D-124: one page's trouble, a card in "Where visitors struggle". */
export interface StrugglePage {
  page: string;
  /** Chats with any trouble on this page (the card's severity). */
  conversations: number;
  /** Its spots, most chats first (at most MAX_PAGE_SPOTS; `moreSpots` were left out). */
  spots: StruggleSpot[];
  moreSpots: number;
  /** The troubled chats, newest first (at most MAX_STRUGGLE_CHATS). */
  chats: StruggleChat[];
  /** Of the troubled chats the report has facts for (`known`), the ones that went to a person. */
  known: number;
  toPerson: number;
}
/** A troubled chat in a card's list; `createdAt` and `outcome` are null when the report has no facts for it. */
export interface StruggleChat {
  id: string;
  createdAt: number | null;
  outcome: ChatOutcome | null;
  kinds: StruggleKind[];
}
/** person: handed to the team (or reached it while AI replies were off) or a teammate replied; ai: only the AI answered; none: no reply. */
export type ChatOutcome = "person" | "ai" | "none";
/** Most pages (cards) "Where visitors struggle" lists, spots (chips) per card, and chats per list. */
export const MAX_STRUGGLE_PAGES = 8;
export const MAX_PAGE_SPOTS = 6;
export const MAX_STRUGGLE_CHATS = 25;
/** Most snapshots a report reads for A-08 (each message's snapshot repeats the trail; one conversation has a few). */
export const MAX_STRUGGLE_SNAPSHOTS = 5_000;

/**
 * A-08: where visitors who chatted got frustrated: rage clicks, dead clicks and "stuck" pages
 * from their trails, by page and element, each counted once per conversation. A click's page
 * is the last page the trail visited before it (else the snapshot's page). Snapshots of one
 * conversation overlap, so events are merged by time and kind first. D-124: grouped by page, worst
 * first, each with its chats and how many of them went to a person (from `facts`, by id).
 */
export function struggleSpots(
  snapshots: SnapshotEvents[],
  facts: ReadonlyMap<string, ConversationFacts> = new Map(),
): { pages: StrugglePage[]; conversations: number } {
  const chats = new Map<string, { pageUrl: string | null; events: Map<string, DebugEvent> }>();
  for (const snap of snapshots) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(snap.events ?? "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    let chat = chats.get(snap.conversationId);
    if (!chat) chats.set(snap.conversationId, (chat = { pageUrl: snap.pageUrl, events: new Map() }));
    for (const e of parsed as DebugEvent[]) if (e && typeof e.t === "number" && typeof e.kind === "string") chat.events.set(`${e.t}|${e.kind}`, e);
  }
  const spots = new Map<string, Omit<StruggleSpot, "chats"> & { all: string[] }>();
  // Per page: its troubled chats and the kinds each one hit there.
  const byPage = new Map<string, Map<string, Set<StruggleKind>>>();
  let affected = 0;
  for (const [id, chat] of chats) {
    const base = chat.pageUrl ?? undefined;
    const pageOf = (url: string | undefined) => {
      try {
        return url ? startPage(new URL(url, base).href) : null;
      } catch {
        return null;
      }
    };
    let page = pageOf(base);
    const seen = new Set<string>();
    for (const e of [...chat.events.values()].sort((a, b) => a.t - b.t)) {
      if (e.kind === "navigation") page = pageOf(e.url) ?? page;
      if (e.kind !== "rage_click" && e.kind !== "dead_click" && e.kind !== "stuck") continue;
      const at = e.kind === "stuck" ? pageOf(e.url) ?? page : page;
      if (!at) continue;
      const target = e.kind === "stuck" ? null : describeTarget(e.target);
      const key = `${e.kind}|${at}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spot = spots.get(key) ?? { kind: e.kind, page: at, target, label: e.kind === "stuck" ? null : targetLabel(e.target), conversations: 0, all: [] };
      spot.conversations++;
      spot.all.push(id);
      spots.set(key, spot);
      const pageChats = byPage.get(at) ?? new Map<string, Set<StruggleKind>>();
      byPage.set(at, pageChats);
      pageChats.set(id, (pageChats.get(id) ?? new Set<StruggleKind>()).add(e.kind));
    }
    if (seen.size) affected++;
  }
  // Rage clicks first on a tie: they're the strongest sign.
  const weight: Record<StruggleKind, number> = { rage_click: 0, stuck: 1, dead_click: 2 };
  const newest = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => (facts.get(b)?.createdAt ?? 0) - (facts.get(a)?.createdAt ?? 0) || a.localeCompare(b));
  const sorted = [...spots.values()]
    .sort((a, b) => b.conversations - a.conversations || weight[a.kind] - weight[b.kind] || (a.label ?? "").localeCompare(b.label ?? ""))
    .map(({ all, ...spot }): StruggleSpot => ({ ...spot, chats: newest(all).slice(0, MAX_STRUGGLE_CHATS) }));
  const pages = [...byPage].map(([page, pageChats]): StrugglePage => {
    const own = sorted.filter((s) => s.page === page);
    let known = 0;
    let toPerson = 0;
    for (const id of pageChats.keys()) {
      const f = facts.get(id);
      if (!f) continue;
      known++;
      if (chatOutcome(f) === "person") toPerson++;
    }
    return {
      page,
      conversations: pageChats.size,
      spots: own.slice(0, MAX_PAGE_SPOTS),
      moreSpots: Math.max(0, own.length - MAX_PAGE_SPOTS),
      chats: newest(pageChats.keys()).slice(0, MAX_STRUGGLE_CHATS).map((id) => {
        const f = facts.get(id);
        return { id, createdAt: f?.createdAt ?? null, outcome: f ? chatOutcome(f) : null, kinds: [...pageChats.get(id)!].sort((a, b) => weight[a] - weight[b]) };
      }),
      known,
      toPerson,
    };
  });
  return {
    // Worst first: the most troubled chats, then the strongest sign, then the path.
    pages: pages
      .sort((a, b) => b.conversations - a.conversations || weight[a.spots[0]!.kind] - weight[b.spots[0]!.kind] || a.page.localeCompare(b.page))
      .slice(0, MAX_STRUGGLE_PAGES),
    conversations: affected,
  };
}

/** A short name for a clicked element: its text, else its aria-label, #id, name, role or tag. */
export function targetLabel(t: DebugTarget | undefined): string {
  if (!t) return "an element";
  return t.text || t.label || (t.id ? `#${t.id}` : "") || t.name || t.role || t.tag || "an element";
}

/**
 * D-124: where a chat ended up. "person" when the AI handed it to the team, it reached the team
 * because AI replies were off, or a teammate replied publicly; else "ai" if the AI answered.
 */
export function chatOutcome(c: ConversationFacts): ChatOutcome {
  if (c.handoffReason !== null || c.aiOffHandoff || c.firstAgentAt !== null) return "person";
  return c.firstAiAt !== null ? "ai" : "none";
}

export interface DurationStat {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface DayPoint {
  /** "2026-10-05", in the report's time zone. */
  day: string;
  conversations: number;
  /** The AI's conversations that day (answered or handed off by it); aiResolved is a subset. */
  ai: number;
  aiResolved: number;
}

/** A-06 / D-124: a page chats started on, or a group of pages under one parent path. */
export interface PageRow {
  /** Grouped page: origin + path, no query or hash, ids as ":id" (see startPage). For a group, the parent path. */
  page: string;
  count: number;
  /** Chats per day, the same days as conversations.series. */
  perDay: number[];
  /** The AI's chats that started here and the ones it resolved alone (the headline's definitions). */
  ai: number;
  aiResolved: number;
  aiResolutionRate: number | null;
  /**
   * A group (at least MIN_PAGE_GROUP pages under this path), most chats first; the row's numbers are
   * their sums. The parent page itself is one of them when chats started there (same `page`).
   */
  children?: PageRow[];
}
/** Pages that share a parent path group under it from this many (the parent page itself not counted). */
export const MIN_PAGE_GROUP = 2;
/** Most top-level rows the report carries ("Show all" on Reports); most pages kept in one group. */
export const MAX_PAGE_ROWS = 40;
export const MAX_GROUP_PAGES = 20;

/**
 * D-124: group start pages under their parent path ("/app/settings/billing" and "/app/settings/team"
 * under "/app/settings") when at least MIN_PAGE_GROUP share it. Deepest first, so a group can sit in
 * a bigger one, and a page left alone joins the nearest ancestor that groups ("/app/settings/billing"
 * under "/app" beside "/app/home" and "/app/inbox"). Never under the site's root ("/"), where it would
 * only fold the whole list away.
 */
export function groupPages(pages: PageRow[]): PageRow[] {
  const split = (page: string) => {
    const u = new URL(page);
    return { origin: u.origin, segments: u.pathname.split("/").filter(Boolean) };
  };
  const nodes = new Map(pages.map((p) => [p.page, p]));
  const depth = (page: string) => split(page).segments.length;
  const deepest = Math.max(0, ...pages.map((p) => depth(p.page)));
  const sum = (rows: PageRow[], at: (r: PageRow) => number) => rows.reduce((s, r) => s + at(r), 0);
  // d: the parent's depth. Every page still on its own below it is a candidate child.
  for (let d = deepest - 1; d >= 1; d--) {
    const under = new Map<string, PageRow[]>();
    for (const node of nodes.values()) {
      const { origin, segments } = split(node.page);
      if (segments.length <= d) continue;
      const parent = `${origin}/${segments.slice(0, d).join("/")}`;
      under.set(parent, [...(under.get(parent) ?? []), node]);
    }
    for (const [parent, kids] of under) {
      if (kids.length < MIN_PAGE_GROUP) continue;
      const self = nodes.get(parent);
      const children = [...kids, ...(self ? [self] : [])].sort(byCount);
      for (const k of kids) nodes.delete(k.page);
      const ai = sum(children, (r) => r.ai);
      const aiResolved = sum(children, (r) => r.aiResolved);
      nodes.set(parent, {
        page: parent,
        count: sum(children, (r) => r.count),
        perDay: children[0]!.perDay.map((_, i) => sum(children, (r) => r.perDay[i]!)),
        ai,
        aiResolved,
        aiResolutionRate: rate(aiResolved, ai),
        children: children.slice(0, MAX_GROUP_PAGES),
      });
    }
  }
  return [...nodes.values()].sort(byCount);
}
const byCount = (a: PageRow, b: PageRow) => b.count - a.count || a.page.localeCompare(b.page);

export interface TopicCount {
  id: string;
  name: string;
  count: number;
  /** Of the labelled conversations in the period. */
  share: number;
  /** AI resolved / AI conversations within this topic (same definitions as the headline), or null. */
  aiResolutionRate: number | null;
  /** Of this topic's conversations, the ones the AI resolved alone. */
  aiResolved: number;
  /** This topic's AI conversations (the rate's whole) and the ones the AI handed to the team (topic map, D-120). */
  ai: number;
  handedOff: number;
}

/** D-126: one grouped handoff reason (handoffReasonLabel), a bar in "Top handoff reasons". */
export interface HandoffReason {
  reason: string;
  count: number;
  /** Of the period's handoffs. */
  share: number;
  /** The most common topics among its labelled chats (at most two), and how many of its chats have a topic. */
  topics: { name: string; count: number }[];
  labeled: number;
  /** Median time from the handoff to the team's first reply, over its chats that got one after it. */
  replyMedian: number | null;
  /** Its chats, newest first (at most MAX_REASON_CHATS). */
  chats: HandoffChat[];
}
/** A handed-off chat in a reason's list. `replyAfter`: handoff to the team's first reply (null: none, or it came before). */
export interface HandoffChat {
  id: string;
  createdAt: number;
  topic: string | null;
  replied: boolean;
  replyAfter: number | null;
}
/** Most reasons the report carries ("Show all" on Reports) and chats per reason. */
export const MAX_HANDOFF_REASONS = 20;
export const MAX_REASON_CHATS = 25;

export interface MetricsReport {
  days: number;
  timezone: string;
  since: number;
  until: number;
  truncated: boolean;
  conversations: {
    total: number;
    resolved: number;
    series: DayPoint[];
    /** Conversations in the period before (same number of days), or null if unknown. */
    previousTotal: number | null;
    /** total / previousTotal - 1; null without a previous count or when it was 0. */
    change: number | null;
  };
  ai: {
    /** AI replies are on right now. */
    enabled: boolean;
    /** Off now and no AI conversations in the period: Reports shows "AI is off" instead of the AI numbers. */
    off: boolean;
    /** Conversations that reached the AI while it was off and went straight to the team. */
    passedWhileOff: number;
    /** Conversations the AI answered, or that the AI handed off (passedWhileOff ones aren't). */
    conversations: number;
    /** …that the AI handled alone: no handoff and no public agent reply. */
    resolved: number;
    handedOff: number;
    resolutionRate: number | null;
    handoffRate: number | null;
    firstResponse: DurationStat;
    /** D-126: grouped reasons, most first (at most MAX_HANDOFF_REASONS). */
    reasons: HandoffReason[];
    /** D-126: handoff to the team's first public reply, over handed-off chats answered after the handoff. */
    handoffReply: DurationStat;
  };
  team: { answered: number; firstResponse: DurationStat };
  csat: { good: number; bad: number; score: number | null; badComments: { conversationId: string; comment: string; createdAt: number }[] };
  teammates: { userId: string; name: string; replies: number; conversations: number; firstResponse: DurationStat }[];
  /**
   * A-06: the pages chats started on, most first, grouped under shared parent paths (D-124; at most
   * MAX_PAGE_ROWS rows); `withoutPage` had no snapshot (e.g. the widget opened outside a site).
   */
  pages: { rows: PageRow[]; withPage: number; withoutPage: number };
  /** A-02: every topic with conversations in the period, most first; `unlabeled`: chats with a visitor message and no topic yet. */
  topics: { list: TopicCount[]; labeled: number; unlabeled: number };
  /** A-08: where visitors who chatted struggled, by page (D-124); `conversations`: chats with any such spot. */
  struggles: { pages: StrugglePage[]; conversations: number };
}

/** Rows "Pages where chats start" shows before "Show all". */
export const MAX_START_PAGES = 8;

/**
 * The reason the Conversation DO gives when a visitor writes in a chat the AI handles while AI
 * replies are off. That's the desk's setting, not the AI handing off, so it never counts as one.
 */
export const AI_OFF_HANDOFF_REASON = "AI replies are turned off.";
export const isAiOffHandoff = (reason: string | null | undefined): boolean => reason?.trim() === AI_OFF_HANDOFF_REASON;

/**
 * Path segments that are ids, not pages: numbers, UUIDs, long hex, prefixed ids ("cus_8f3k2a"),
 * long letter+digit tokens, and the masks redaction leaves ("[number]").
 */
const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)[0-9a-f]{12,}$/i,
  /^[a-z]{1,10}_(?=[a-z]*\d)[a-z0-9]{6,}$/i,
  /^(?=.*\d)(?=.*[a-z])[a-z0-9]{16,}$/i,
  /^(?:\[|%5B)[a-z]+(?:\]|%5D)$/i,
];

/**
 * A-06: the page a chat started on, grouped: origin + path without query or hash, no trailing
 * slash, id segments as ":id" ("/invoices/123" → "/invoices/:id"). Null if it isn't a web URL.
 */
export function startPage(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => (ID_SEGMENT.some((re) => re.test(s)) ? ":id" : s))
    .join("/");
  return `${u.origin}/${path}`;
}

/** `days` from a query string, or null if it isn't one of the periods. */
export function parsePeriod(raw: string | null | undefined): MetricPeriod | null {
  const n = Number(raw);
  return (METRIC_PERIODS as readonly number[]).includes(n) && String(n) === raw ? (n as MetricPeriod) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsAt(t: number, timezone: string): Record<string, number> {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** The calendar day of `t` in `timezone`, as "YYYY-MM-DD". */
export function dayKey(t: number, timezone: string): string {
  const p = partsAt(t, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "2026-10-05" plus n days (calendar arithmetic, no time zone involved). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Local time minus UTC at `t`, in ms. */
function offsetAt(t: number, timezone: string): number {
  const p = partsAt(t, timezone);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** When the day `key` starts in `timezone` (epoch ms). Two passes so a DST change that day is right. */
export function startOfDay(key: string, timezone: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const guess = utc - offsetAt(utc, timezone);
  return utc - offsetAt(guess, timezone);
}

/** The period: today and the days before it, `days` calendar days in all. */
export function periodDays(now: number, days: number, timezone: string): { keys: string[]; since: number; until: number } {
  const today = dayKey(now, timezone);
  const keys = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  return { keys, since: startOfDay(keys[0]!, timezone), until: startOfDay(addDays(today, 1), timezone) };
}

/** The `days` calendar days just before the period, for comparing against. */
export function previousPeriod(now: number, days: number, timezone: string): { since: number; until: number } {
  const { keys, since } = periodDays(now, days, timezone);
  return { since: startOfDay(addDays(keys[0]!, -days), timezone), until: since };
}

/** Median (mean of the middle two for an even count) and p90 (nearest rank) of durations. */
export function durationStat(values: number[]): DurationStat {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, median: null, p90: null };
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return { count: n, median, p90: sorted[Math.ceil(0.9 * n) - 1]! };
}

/**
 * Groups handoff reasons that differ only in details: "AI error: <message>" and "Bug flagged by
 * the AI: <what broke>" become one line each, as does the reply cap's number.
 */
export function handoffReasonLabel(reason: string): string {
  const text = reason.trim().replace(/\s+/g, " ");
  const prefix = /^(Bug flagged by the AI|AI error|AI unavailable):/i.exec(text);
  if (prefix) return prefix[1]!;
  if (/^Monthly AI reply cap \(\d+\) reached/i.test(text)) return "Monthly AI reply cap reached";
  const label = text.replace(/\.$/, "");
  return label.length > 120 ? `${label.slice(0, 119)}…` : label || "No reason given";
}

/** "45s", "3m", "1h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const rate = (part: number, whole: number) => (whole ? part / whole : null);

export function computeMetrics(input: MetricsInput): MetricsReport {
  const { keys, since, until } = periodDays(input.now, input.days, input.timezone);
  // Day boundaries once, then a binary search per row: no Intl call per conversation.
  const starts = [...keys.map((k) => startOfDay(k, input.timezone)), until];
  const dayIndex = (t: number): number => {
    if (t < since || t >= until) return -1;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const series: DayPoint[] = keys.map((day) => ({ day, conversations: 0, ai: 0, aiResolved: 0 }));
  let total = 0;
  let resolved = 0;
  let aiConversations = 0;
  let aiResolved = 0;
  let handedOff = 0;
  const aiTimes: number[] = [];
  const teamTimes: number[] = [];
  const byAgent = new Map<string, number[]>();
  const reasons = new Map<string, { reason: string; count: number; topics: Map<string, number>; labeled: number; chats: HandoffChat[]; replies: number[] }>();
  const handoffReplies: number[] = [];
  let passedWhileOff = 0;
  const pages = new Map<string, PageRow>();
  let withoutPage = 0;
  const topics = new Map<string, { id: string; name: string; count: number; ai: number; aiResolved: number; handedOff: number }>();
  let unlabeled = 0;

  for (const c of input.conversations) {
    const i = dayIndex(c.createdAt);
    if (i === -1) continue;
    total++;
    series[i]!.conversations++;
    if (c.resolved) resolved++;
    const pageKey = startPage(c.startUrl);
    const page = pageKey ? (pages.get(pageKey) ?? { page: pageKey, count: 0, perDay: keys.map(() => 0), ai: 0, aiResolved: 0, aiResolutionRate: null }) : null;
    if (page) {
      page.count++;
      page.perDay[i]!++;
      pages.set(page.page, page);
    } else withoutPage++;

    // A handoff only happens from AI handling, so a handed-off conversation was the AI's even if
    // it never got to answer (the visitor asked for a person first, or its first reply was a
    // handoff). Not when AI replies were off: the team was answering anyway. If the AI answered
    // before it was turned off, it's an AI conversation, but neither resolved nor handed off.
    const aiOff = c.aiOffHandoff || isAiOffHandoff(c.handoffReason);
    if (aiOff) passedWhileOff++;
    const handed = c.handoffReason !== null && !isAiOffHandoff(c.handoffReason);
    const topic = c.topicId && c.topicName ? (topics.get(c.topicId) ?? { id: c.topicId, name: c.topicName, count: 0, ai: 0, aiResolved: 0, handedOff: 0 }) : null;
    if (topic) {
      topic.count++;
      topics.set(topic.id, topic);
    } else if (c.firstVisitorAt !== null) unlabeled++;
    if (c.firstAiAt !== null || handed) {
      aiConversations++;
      series[i]!.ai++;
      if (topic) topic.ai++;
      if (page) page.ai++;
      if (handed) {
        handedOff++;
        if (topic) topic.handedOff++;
        const label = handoffReasonLabel(c.handoffReason!);
        const key = label.toLowerCase();
        const entry = reasons.get(key) ?? { reason: label, count: 0, topics: new Map<string, number>(), labeled: 0, chats: [] as HandoffChat[], replies: [] as number[] };
        entry.count++;
        if (topic) {
          entry.labeled++;
          entry.topics.set(topic.name, (entry.topics.get(topic.name) ?? 0) + 1);
        }
        // Only a reply after the handoff is the team picking it up (an earlier one came before the AI had it back).
        const at = c.handoffAt ?? null;
        const replyAfter = at !== null && c.firstAgentAt !== null && c.firstAgentAt >= at ? c.firstAgentAt - at : null;
        if (replyAfter !== null) {
          entry.replies.push(replyAfter);
          handoffReplies.push(replyAfter);
        }
        entry.chats.push({ id: c.id, createdAt: c.createdAt, topic: topic?.name ?? null, replied: c.firstAgentAt !== null, replyAfter });
        reasons.set(key, entry);
      } else if (c.firstAgentAt === null && !aiOff) {
        aiResolved++;
        series[i]!.aiResolved++;
        if (topic) topic.aiResolved++;
        if (page) page.aiResolved++;
      }
    }
    if (c.firstVisitorAt !== null && c.firstAiAt !== null && c.firstAiAt >= c.firstVisitorAt) aiTimes.push(c.firstAiAt - c.firstVisitorAt);
    if (c.firstVisitorAt !== null && c.firstAgentAt !== null && c.firstAgentAt >= c.firstVisitorAt) {
      const ms = c.firstAgentAt - c.firstVisitorAt;
      teamTimes.push(ms);
      if (c.firstAgentId) {
        const list = byAgent.get(c.firstAgentId) ?? [];
        list.push(ms);
        byAgent.set(c.firstAgentId, list);
      }
    }
  }

  let good = 0;
  let bad = 0;
  const badComments: MetricsReport["csat"]["badComments"] = [];
  for (const r of [...input.ratings].sort((a, b) => b.createdAt - a.createdAt)) {
    if (dayIndex(r.createdAt) === -1) continue;
    if (r.rating === "good") good++;
    else {
      bad++;
      const comment = r.comment?.trim();
      if (comment && badComments.length < 5) badComments.push({ conversationId: r.conversationId, comment, createdAt: r.createdAt });
    }
  }

  // Every member, plus anyone who replied and has since left the team.
  const replies = new Map(input.replies.map((r) => [r.userId, r]));
  const names = new Map(input.members.map((m) => [m.userId, m.name]));
  const ids = new Set([...names.keys(), ...replies.keys(), ...byAgent.keys()]);
  const teammates = [...ids]
    .map((userId) => ({
      userId,
      name: names.get(userId) ?? "Former teammate",
      replies: replies.get(userId)?.replies ?? 0,
      conversations: replies.get(userId)?.conversations ?? 0,
      firstResponse: durationStat(byAgent.get(userId) ?? []),
    }))
    .sort((a, b) => b.replies - a.replies || a.name.localeCompare(b.name));

  return {
    days: input.days,
    timezone: input.timezone,
    since,
    until,
    truncated: input.truncated,
    conversations: {
      total,
      resolved,
      series,
      previousTotal: input.previousTotal ?? null,
      change: input.previousTotal ? total / input.previousTotal - 1 : null,
    },
    ai: {
      enabled: input.aiEnabled,
      off: !input.aiEnabled && aiConversations === 0,
      passedWhileOff,
      conversations: aiConversations,
      resolved: aiResolved,
      handedOff,
      resolutionRate: rate(aiResolved, aiConversations),
      handoffRate: rate(handedOff, aiConversations),
      firstResponse: durationStat(aiTimes),
      reasons: [...reasons.values()]
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, MAX_HANDOFF_REASONS)
        .map((x): HandoffReason => ({
          reason: x.reason,
          count: x.count,
          share: x.count / handedOff,
          topics: [...x.topics].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name, count]) => ({ name, count })),
          labeled: x.labeled,
          replyMedian: durationStat(x.replies).median,
          chats: x.chats.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_REASON_CHATS),
        })),
      handoffReply: durationStat(handoffReplies),
    },
    team: { answered: teamTimes.length, firstResponse: durationStat(teamTimes) },
    csat: { good, bad, score: rate(good, good + bad), badComments },
    teammates,
    pages: {
      rows: groupPages([...pages.values()].map((p) => ({ ...p, aiResolutionRate: rate(p.aiResolved, p.ai) }))).slice(0, MAX_PAGE_ROWS),
      withPage: total - withoutPage,
      withoutPage,
    },
    topics: (() => {
      const labeled = [...topics.values()].reduce((s, t) => s + t.count, 0);
      return {
        list: [...topics.values()]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .map((t) => ({ id: t.id, name: t.name, count: t.count, share: t.count / labeled, aiResolutionRate: rate(t.aiResolved, t.ai), aiResolved: t.aiResolved, ai: t.ai, handedOff: t.handedOff })),
        labeled,
        unlabeled,
      };
    })(),
    struggles: struggleSpots(input.snapshots ?? [], new Map(input.conversations.map((c) => [c.id, c]))),
  };
}
