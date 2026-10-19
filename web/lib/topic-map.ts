import type { TopicCount } from "../../shared/metrics.ts";

// D-120: the Reports topic map's pure parts: which topics go on it, the chats scale (log when the
// counts spread widely), the colour field's blobs and the hue at a point, and where each label fits.
// Plot coordinates are 0..1 with y up: x = chats, y = the share the AI resolved alone.

/** Fewer topics with AI chats than this: Reports shows the rows only. */
export const MIN_MAP_TOPICS = 5;

export interface MapTopic {
  id: string;
  name: string;
  count: number;
  /** AI resolved / AI chats in this topic (computeMetrics' definition). */
  rate: number;
  ai: number;
  aiResolved: number;
  handedOff: number;
}

/** The topics the map can place: those with AI chats (a rate). The others have no y. */
export function mapTopics(list: TopicCount[]): MapTopic[] {
  return list.flatMap((t) =>
    t.aiResolutionRate === null ? [] : [{ id: t.id, name: t.name, count: t.count, rate: t.aiResolutionRate, ai: t.ai, aiResolved: t.aiResolved, handedOff: t.handedOff }],
  );
}

export interface ChatScale {
  log: boolean;
  lo: number;
  hi: number;
  ticks: number[];
  /** A count's place on the axis, 0..1. */
  at: (v: number) => number;
}

/** Counts spreading this much (max / min) or more go on a log scale. */
export const LOG_SPREAD = 10;

const niceStep = (raw: number) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/**
 * The chats axis. Log (1-2-5 ticks, padded half a step each side) when the counts spread widely,
 * else linear from 0 to a round number above the largest. At most `maxTicks` labelled ticks.
 */
export function chatScale(counts: number[], maxTicks: number): ChatScale {
  const positive = counts.filter((c) => c > 0);
  const min = positive.length ? Math.min(...positive) : 1;
  const max = positive.length ? Math.max(...positive) : 1;
  if (max / min >= LOG_SPREAD) {
    const lo = min / 1.6;
    const hi = max * 1.6;
    const all: number[] = [];
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) for (const m of [1, 2, 5]) all.push(m * 10 ** k);
    let ticks = all.filter((t) => t >= lo && t <= hi && t >= 1);
    if (ticks.length > maxTicks) ticks = ticks.filter((t) => Math.log10(t) % 1 === 0);
    while (ticks.length > maxTicks) ticks = ticks.filter((_, i) => i % 2 === 0);
    const span = Math.log(hi) - Math.log(lo);
    return { log: true, lo, hi, ticks, at: (v) => (Math.log(Math.max(v, lo)) - Math.log(lo)) / span };
  }
  let step = niceStep(Math.max(1, (max * 1.1) / Math.max(1, maxTicks - 1)));
  let hi = Math.ceil((max * 1.1) / step) * step;
  if (hi / step + 1 > maxTicks) {
    step = niceStep(step * 1.5);
    hi = Math.ceil((max * 1.1) / step) * step;
  }
  const ticks = Array.from({ length: Math.round(hi / step) + 1 }, (_, i) => i * step);
  return { log: false, lo: 0, hi, ticks, at: (v) => v / hi };
}

/**
 * The colour field's blobs (plot coordinates, radius as a share of the plot's size, OKLCH hue).
 * Laid out by meaning: warm red/pink where many chats rarely end with the AI (needs work), violet
 * and blue for quieter topics the AI struggles with, cyan in the middle, green and yellow where the
 * AI resolves. The rainbow runs red → pink → violet → blue → cyan → green → yellow around the plot.
 */
export const FIELD_BLOBS: { x: number; y: number; r: number; hue: number }[] = [
  { x: 0.86, y: 0.14, r: 0.3, hue: 25 },
  { x: 0.52, y: 0.08, r: 0.26, hue: 355 },
  { x: 0.14, y: 0.2, r: 0.26, hue: 305 },
  { x: 0.2, y: 0.56, r: 0.26, hue: 262 },
  { x: 0.56, y: 0.48, r: 0.24, hue: 215 },
  { x: 0.3, y: 0.9, r: 0.28, hue: 150 },
  { x: 0.82, y: 0.84, r: 0.3, hue: 98 },
];

/** The field's hue at a point: blobs weighted by closeness (sharp, so a dot reads as the blob it sits on). */
export function fieldHue(x: number, y: number): number {
  let sx = 0;
  let sy = 0;
  for (const b of FIELD_BLOBS) {
    const d2 = (x - b.x) ** 2 + (y - b.y) ** 2;
    const w = Math.exp(-d2 / (2 * 0.14 ** 2)) + 1e-9;
    sx += w * Math.cos((b.hue * Math.PI) / 180);
    sy += w * Math.sin((b.hue * Math.PI) / 180);
  }
  const h = (Math.atan2(sy, sx) * 180) / Math.PI;
  return Math.round((h + 360) % 360);
}

export type LabelSide = "right" | "left" | "above" | "below";
export interface LabelPoint {
  id: string;
  /** Pixel centre of the dot. */
  x: number;
  y: number;
  /** The label's width in px. */
  w: number;
}

/** Width of a label in Geist Mono at 12px (0.6em per character). */
export const labelWidth = (text: string) => Math.ceil(text.length * 7.2);
/** Longest label drawn; longer names end in an ellipsis (the whole name is in the tooltip). */
export const MAX_LABEL = 24;
export const shortLabel = (name: string) => (name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name);

const LABEL_H = 14;
const GAP = 8;
const DOT = 6;

/**
 * Where each label goes, in the order given (put the biggest topics first): right of the dot, else
 * left, above, below; one that fits nowhere inside the plot without covering another label or dot
 * is hidden (null) and shows in the dot's tooltip instead. Above and below, a label near a side slides
 * inwards to fit (`x` is its centre then).
 */
export function placeLabels(points: LabelPoint[], width: number, height: number): Map<string, { side: LabelSide; x: number } | null> {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out = new Map<string, { side: LabelSide; x: number } | null>();
  const centre = (p: LabelPoint) => Math.min(Math.max(p.x, p.w / 2), Math.max(p.w / 2, width - p.w / 2));
  const box = (p: LabelPoint, side: LabelSide) => {
    const half = LABEL_H / 2;
    const cx = centre(p);
    switch (side) {
      case "right": return { x0: p.x + GAP, y0: p.y - half, x1: p.x + GAP + p.w, y1: p.y + half };
      case "left": return { x0: p.x - GAP - p.w, y0: p.y - half, x1: p.x - GAP, y1: p.y + half };
      case "above": return { x0: cx - p.w / 2, y0: p.y - GAP - LABEL_H, x1: cx + p.w / 2, y1: p.y - GAP };
      case "below": return { x0: cx - p.w / 2, y0: p.y + GAP, x1: cx + p.w / 2, y1: p.y + GAP + LABEL_H };
    }
  };
  const hits = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (const p of points) {
    const side = (["right", "left", "above", "below"] as const).find((s) => {
      const b = box(p, s);
      if (b.x0 < 0 || b.x1 > width || b.y0 < 0 || b.y1 > height) return false;
      if (placed.some((o) => hits(b, o))) return false;
      return !points.some((q) => q !== p && hits(b, { x0: q.x - DOT, y0: q.y - DOT, x1: q.x + DOT, y1: q.y + DOT }));
    });
    out.set(p.id, side ? { side, x: side === "right" ? p.x + GAP : side === "left" ? p.x - GAP : centre(p) } : null);
    if (side) placed.push(box(p, side));
  }
  return out;
}

/** Dots that land on (nearly) the same pixel move apart sideways, so each stays visible and clickable. */
export function spreadDots<T extends { x: number; y: number }>(dots: T[], min = 9): T[] {
  const out: T[] = [];
  for (const d of dots) {
    let x = d.x;
    for (let i = 0; i < 8 && out.some((o) => Math.hypot(o.x - x, o.y - d.y) < min); i++) x = d.x + (i % 2 ? -1 : 1) * Math.ceil((i + 1) / 2) * min;
    out.push({ ...d, x });
  }
  return out;
}
