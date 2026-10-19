import type { TopicCount } from "../../shared/metrics.ts";

// D-123: the sentence beside Top topics' bars (D-125), written from the numbers (no AI call). Pure: a
// list of parts the page draws, topic names and numbers emphasised, the top topic in its bar's blue.

export type InsightPart =
  | string
  | { strong: string }
  /** A topic's name; `lead` marks the top topic, drawn in its bar's strong blue with a dot. */
  | { topic: string; id: string; lead?: boolean };

/** A topic needs this many AI chats before the sentence says how well the AI does on it. */
export const MIN_AI_CHATS = 3;
/** The AI resolving less than this of a busy topic's AI chats is worth naming. */
const WEAK_RATE = 0.5;
/** The top topics together making up this share is the first sentence's claim. */
const LEAD_SHARE = 0.4;

const pct = (r: number) => `${Math.round(r * 100)}%`;
const name = (t: TopicCount, lead = false): InsightPart => ({ topic: t.name, id: t.id, ...(lead ? { lead } : {}) });

/** "A", "A and B", "A, B and C". */
function names(list: TopicCount[]): InsightPart[] {
  const out: InsightPart[] = [];
  list.forEach((t, i) => {
    if (i > 0) out.push(i === list.length - 1 ? " and " : ", ");
    out.push(name(t, i === 0));
  });
  return out;
}

/**
 * One or two sentences about the period's topics (sorted biggest first, as computeMetrics gives them):
 * how much the biggest one to three make up, then the busy topic the AI resolves least (or, when every
 * busy topic does well, the lowest rate). `showAi` false (AI off) leaves the AI out. Empty list: null.
 */
export function topicInsight(list: TopicCount[], labeled: number, showAi: boolean): InsightPart[] | null {
  if (list.length === 0 || labeled === 0) return null;
  const parts: InsightPart[] = [];
  if (list.length === 1) {
    parts.push(labeled === 1 ? "The one labelled chat is about " : `All ${labeled.toLocaleString()} labelled chats are about `, name(list[0]!, true), ".");
  } else if (list[0]!.share >= LEAD_SHARE && list[0]!.count > list[1]!.count) {
    parts.push(name(list[0]!, true), " alone is ", { strong: pct(list[0]!.share) }, " of labelled chats.");
  } else {
    // The fewest top topics (two or three; two when the top two tie) that make up LEAD_SHARE; else chats are spread out.
    let k = 0;
    let sum = 0;
    while (k < Math.min(3, list.length) && (k < 2 || sum < LEAD_SHARE)) sum += list[k++]!.share;
    if (sum >= LEAD_SHARE || list.length <= 3) {
      parts.push(...names(list.slice(0, k)), " make up ", { strong: pct(sum) }, " of labelled chats.");
    } else {
      parts.push("Chats spread over ", { strong: `${list.length} topics` }, "; the biggest, ", name(list[0]!, true), ", is ", { strong: pct(list[0]!.share) }, ".");
    }
  }
  if (!showAi) return parts;
  const busy = list.filter((t) => t.ai >= MIN_AI_CHATS && t.aiResolutionRate !== null);
  if (busy.length === 0) return parts;
  const weakest = busy.reduce((w, t) => (t.aiResolutionRate! < w.aiResolutionRate! ? t : w));
  const rate = weakest.aiResolutionRate!;
  if (rate === 0) {
    parts.push(" The AI resolves ", { strong: "none" }, " of the ", name(weakest), " chats it handles.");
  } else if (rate < WEAK_RATE) {
    parts.push(" The AI resolves only ", { strong: pct(rate) }, " of the ", name(weakest), " chats it handles.");
  } else if (busy.length === 1) {
    parts.push(" The AI resolves ", { strong: pct(rate) }, " of the ", name(weakest), " chats it handles.");
  } else {
    parts.push(" The AI resolves at least ", { strong: pct(rate) }, " of the chats it handles in every busy topic.");
  }
  return parts;
}

/** The sentence as plain text (tests, aria). */
export const insightText = (parts: InsightPart[]) =>
  parts.map((p) => (typeof p === "string" ? p : "strong" in p ? p.strong : p.topic)).join("");
