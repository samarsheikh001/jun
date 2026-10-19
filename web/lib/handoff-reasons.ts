import type { HandoffReason } from "../../shared/metrics.ts";
import type { InsightPart } from "./topic-insight.ts";

// D-126: Top handoff reasons' next step per reason and the sentence over its bars, from the numbers
// (no AI call). Pure. Reasons arrive grouped by handoffReasonLabel (shared/metrics.ts).

export type HandoffStepKind = "knowledge" | "bug" | "ai-settings";
/** A one-line next step: a link to `path`, or (bug) open the reason's chats, where an issue is filed from a chat. */
export interface HandoffStep {
  kind: HandoffStepKind;
  /** The button's words. */
  label: string;
  path?: string;
}

/**
 * Which next step a grouped reason has, from how the desk and the AI write them:
 * - the Conversation DO's "AI error: …", "AI unavailable: …", "The AI gave an empty reply." and the
 *   monthly cap → AI settings (provider, model, cap);
 * - "Bug flagged by the AI: …" (flag_problem) or a reason naming a bug → the chats, to file an issue from one;
 * - replyOutcome's "The AI couldn't answer from the knowledge base." and the model's own words for a
 *   gap ("not in the knowledge", "no docs on…", "couldn't find…") → Knowledge.
 * A customer asking for a person, a handoff topic from the instructions or staff-only work (refunds,
 * cancellations) gets none: that's the handoff working as configured.
 */
export function handoffNextStep(reason: string): HandoffStep | null {
  const r = reason.trim();
  if (/^(AI error|AI unavailable)$/i.test(r) || /^The AI gave an empty reply/i.test(r)) {
    return { kind: "ai-settings", label: "Check AI settings", path: "/settings/ai" };
  }
  if (/^Monthly AI reply cap reached$/i.test(r)) {
    return { kind: "ai-settings", label: "Raise the reply cap", path: "/settings/ai" };
  }
  if (/^Bug flagged by the AI$/i.test(r) || /\bbugs?\b/i.test(r)) {
    return { kind: "bug", label: "Create an issue from a chat" };
  }
  if (
    /\bknowledge\b/i.test(r) ||
    /\b(no|missing|not in the|isn't in the|not covered by the|outside the) (docs|documentation|help (center|centre|articles?)|articles?|information|info|answer)\b/i.test(r) ||
    /\b(couldn't|could not|can't|cannot) (find|answer)\b/i.test(r) ||
    /\b(not|isn't|un)documented\b/i.test(r)
  ) {
    return { kind: "knowledge", label: "Add to Knowledge", path: "/knowledge" };
  }
  return null;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
/** A gap this big a share of handoffs is worth its own sentence. */
const GAP_SHARE = 0.15;

/**
 * One or two sentences over the bars (reasons most first, as computeMetrics gives them): the top
 * reason's share (and the runner-up when nothing has a majority), then how many handoffs a knowledge
 * gap explains when the first sentence didn't name one. The reason names are `topic` parts, the top one `lead`.
 */
export function handoffInsight(reasons: HandoffReason[], handedOff: number): InsightPart[] | null {
  if (reasons.length === 0 || handedOff === 0) return null;
  const [top, next] = reasons as [HandoffReason, HandoffReason | undefined];
  const name = (x: HandoffReason, lead = false): InsightPart => ({ topic: x.reason, id: x.reason, ...(lead ? { lead } : {}) });
  const parts: InsightPart[] = [];
  if (reasons.length === 1) {
    parts.push(handedOff === 1 ? "The one handoff's reason: " : `All ${handedOff.toLocaleString()} handoffs had one reason: `, name(top, true), ".");
  } else if (top.share > 0.5) {
    parts.push(name(top, true), " is behind most handoffs (", { strong: pct(top.share) }, ").");
  } else if (next && top.count === next.count) {
    parts.push(name(top, true), " and ", name(next), " tie at ", { strong: pct(top.share) }, " of handoffs each.");
  } else {
    parts.push(name(top, true), " leads with ", { strong: pct(top.share) }, " of handoffs", ...(next ? [", then ", name(next), ` (${pct(next.share)})`] : []), ".");
  }
  // Not when the first sentence already named a gap reason.
  const named = parts.flatMap((p) => (typeof p === "object" && "topic" in p ? [p.topic] : []));
  const gaps = reasons.filter((x) => handoffNextStep(x.reason)?.kind === "knowledge");
  const gap = gaps.reduce((s, x) => s + x.count, 0) / handedOff;
  if (gaps.length > 0 && !gaps.some((x) => named.includes(x.reason)) && gap >= GAP_SHARE) {
    parts.push(" ", { strong: pct(gap) }, " were questions the knowledge didn't answer.");
  }
  return parts;
}

/** "mostly Refunds, Billing" when those topics cover at least half the reason's labelled chats, else "often …"; null without topics. */
export function reasonTopicsLine(x: Pick<HandoffReason, "topics" | "labeled">): string | null {
  if (x.topics.length === 0 || x.labeled === 0) return null;
  const covered = x.topics.reduce((s, t) => s + t.count, 0);
  return `${covered * 2 >= x.labeled ? "mostly" : "often"} ${x.topics.map((t) => t.name).join(", ")}`;
}
