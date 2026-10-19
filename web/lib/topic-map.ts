import type { TopicCount } from "../../shared/metrics.ts";

// D-120: the Reports topic map's pure parts: which topics go on it, the chats scale (log when the
// counts spread widely), the colour field's blobs and the hue at a point, and where each label fits.
// Plot coordinates are 0..1 with y up: x = chats, y = the share the AI resolved alone.

/** Fewer topics with AI chats than this: Reports shows the rows only. One dot already says which side of the field a topic is on. */
export const MIN_MAP_TOPICS = 1;

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

/** The chats scale the dots' colours are read on: the wide map's, so a colour never changes with the screen. */
export const HUE_TICKS = 7;

/**
 * Each mapped topic's dot colour (D-120, D-123): the field's hue at its plot position (chats on the
 * wide map's scale, the AI's rate). The map's dots and Top topics' bar both read their colours here.
 */
export function mapHues(topics: { id: string; count: number; rate: number }[]): Map<string, number> {
  const scale = chatScale(topics.map((t) => t.count), HUE_TICKS);
  return new Map(topics.map((t) => [t.id, fieldHue(scale.at(t.count), t.rate)]));
}

/** Hues closer than this (degrees) read as the same colour. */
export const MIN_HUE_GAP = 24;

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const hashHue = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 24) * 15;
};

/**
 * Every topic's hue (D-123): a mapped topic's dot colour; a topic with no AI chats (no map position)
 * gets a stable hue from its id, moved round the wheel to the first one at least MIN_HUE_GAP from the
 * hues already used (the closest it can get when none is free).
 */
export function topicHues(list: TopicCount[]): Map<string, number> {
  const out = mapHues(mapTopics(list));
  for (const t of list) {
    if (out.has(t.id)) continue;
    const used = [...out.values()];
    const start = hashHue(t.id);
    let best = start;
    let bestGap = -1;
    for (let i = 0; i < 24; i++) {
      const h = (start + i * 15) % 360;
      const gap = used.length ? Math.min(...used.map((u) => hueGap(u, h))) : 360;
      if (gap >= MIN_HUE_GAP) { best = h; break; }
      if (gap > bestGap) { best = h; bestGap = gap; }
    }
    out.set(t.id, best);
  }
  return out;
}

export type LabelSide ="right" | "left" | "above" | "below";
/** Lightness steps for topics sharing a hue (darker first, then lighter), so neighbours in a bar stay apart. */
const SHADE_STEPS = [0, -0.14, 0.1, -0.24, 0.16, -0.32];

/**
 * D-123: a lightness offset per topic, in the order given (biggest first): 0 for the first of each hue,
 * then SHADE_STEPS for each later topic within MIN_HUE_GAP of earlier ones. The hue itself never changes.
 */
export function hueShades(ids: string[], hues: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  ids.forEach((id, i) => {
    const h = hues.get(id) ?? 0;
    const same = ids.slice(0, i).filter((o) => hueGap(hues.get(o) ?? 0, h) < MIN_HUE_GAP).length;
    out.set(id, SHADE_STEPS[same % SHADE_STEPS.length]!);
  });
  return out;
}

export interface LabelPoint {
  id: string;
  /** Pixel centre of the dot. */
  x: number;
  y: number;
  /** The label's width in px. */
  w: number;
}

/**
 * Fallback width of a label in Geist Mono 500 at 12px (about 0.62em per character, measured), for when
 * the browser can't measure it (TopicMap measures with canvas `measureText`).
 */
export const labelWidth = (text: string) => Math.ceil(text.length * 7.5);
/** Longest label drawn; longer names end in an ellipsis (the whole name is in the tooltip). */
export const MAX_LABEL = 24;
export const shortLabel = (name: string) => (name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name);

const LABEL_H = 14;
const GAP = 8;
const DOT = 6;
/** Room kept between two labels' boxes, so neighbours never read as one name. */
export const LABEL_GAP = 6;

export interface LabelBox { x0: number; y0: number; x1: number; y1: number }

/** The box a point's label covers on a side (`width` is the plot's, for sliding above / below labels inwards). */
export function labelBox(p: LabelPoint, side: LabelSide, width: number): LabelBox {
  const half = LABEL_H / 2;
  const cx = Math.min(Math.max(p.x, p.w / 2), Math.max(p.w / 2, width - p.w / 2));
  switch (side) {
    case "right": return { x0: p.x + GAP, y0: p.y - half, x1: p.x + GAP + p.w, y1: p.y + half };
    case "left": return { x0: p.x - GAP - p.w, y0: p.y - half, x1: p.x - GAP, y1: p.y + half };
    case "above": return { x0: cx - p.w / 2, y0: p.y - GAP - LABEL_H, x1: cx + p.w / 2, y1: p.y - GAP };
    case "below": return { x0: cx - p.w / 2, y0: p.y + GAP, x1: cx + p.w / 2, y1: p.y + GAP + LABEL_H };
  }
}

/** Whether two boxes overlap, or come closer than `pad`. */
export const boxesMeet = (a: LabelBox, b: LabelBox, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

const SIDES = ["right", "left", "above", "below"] as const;

/**
 * Where each label goes, in the order given (put the biggest topics first): right of the dot, else
 * left, above, below. Every spot is checked against the plot's edges, every label already placed (kept
 * LABEL_GAP apart) and every other dot; a label that fits nowhere is hidden (null) and shows in the
 * dot's tooltip instead. Above and below, a label near a side slides inwards to fit (`x` is its centre then).
 */
export function placeLabels(points: LabelPoint[], width: number, height: number): Map<string, { side: LabelSide; x: number } | null> {
  const placed: LabelBox[] = [];
  const out = new Map<string, { side: LabelSide; x: number } | null>();
  const dots = points.map((q) => ({ q, box: { x0: q.x - DOT, y0: q.y - DOT, x1: q.x + DOT, y1: q.y + DOT } }));
  for (const p of points) {
    const side = SIDES.find((s) => {
      const b = labelBox(p, s, width);
      if (b.x0 < 0 || b.x1 > width || b.y0 < 0 || b.y1 > height) return false;
      if (placed.some((o) => boxesMeet(b, o, LABEL_GAP))) return false;
      return !dots.some((d) => d.q !== p && boxesMeet(b, d.box));
    });
    if (!side) {
      out.set(p.id, null);
      continue;
    }
    const b = labelBox(p, side, width);
    out.set(p.id, { side, x: side === "right" ? b.x0 : side === "left" ? b.x1 : (b.x0 + b.x1) / 2 });
    placed.push(b);
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
