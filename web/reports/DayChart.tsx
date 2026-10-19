import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { DayPoint } from "../../shared/metrics.ts";

// A-01: conversations per day as a ribbon: the day's parts stacked symmetrically around a centre line,
// resolved by the AI innermost in the strongest blue, the AI's other chats and the team's lighter outside.
// Plain SVG (no chart library), drawn at the measured pixel width so text and pills stay crisp. A soft
// glow in the same blue sits behind the busiest stretch. Hover or the arrow keys move one marker to a day.

const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });

type Part = "aiResolved" | "aiThenTeam" | "team";
const PARTS: { key: Part; label: string }[] = [
  { key: "aiResolved", label: "Resolved by the AI" },
  { key: "aiThenTeam", label: "AI, then the team" },
  { key: "team", label: "Team only" },
];

const dayParts = (d: DayPoint, showAi: boolean): Record<Part, number> =>
  showAi ? { aiResolved: d.aiResolved, aiThenTeam: d.ai - d.aiResolved, team: d.conversations - d.ai } : { aiResolved: 0, aiThenTeam: 0, team: d.conversations };

const HEIGHT = 240;
/** Room above and below the ribbon's widest point for the pills on its edges. */
const EDGE = 22;
/** The first and last day sit this far in from the sides, so their markers' pills fit. */
const PAD = 24;
/** Width one date label needs on the axis. */
const LABEL_W = 60;

/** Fritsch–Carlson tangents: the curve through the points never overshoots them (so never below 0). */
function tangents(ys: number[]): number[] {
  const n = ys.length;
  if (n < 2) return ys.map(() => 0);
  const d = ys.slice(1).map((y, i) => y - ys[i]!);
  const m = ys.map((_, i) => (i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return m;
}

/** The monotone cubic through ys (one per unit of u) at u. */
function at(ys: number[], m: number[], u: number): number {
  const n = ys.length;
  if (n === 1) return ys[0]!;
  const i = Math.min(n - 2, Math.max(0, Math.floor(u)));
  const t = Math.min(1, Math.max(0, u - i));
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * m[i + 1]!;
}

/** The centre of the busiest run of days (a window about a week of a month wide), for the glow. */
function busiestStretch(totals: number[]): number {
  const w = Math.max(1, Math.round(totals.length / 6));
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i + w <= totals.length; i++) {
    const s = totals.slice(i, i + w).reduce((a, b) => a + b, 0);
    if (s > best) {
      best = s;
      bestAt = i;
    }
  }
  return bestAt + (w - 1) / 2;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function DayChart({ series, showAi, onHover }: { series: DayPoint[]; showAi: boolean; onHover: (day: DayPoint | null) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const [ref, width] = useWidth();
  const n = series.length;
  const totals = series.map((d) => d.conversations);
  const max = Math.max(0, ...totals);
  const empty = max === 0;
  // Only the parts that happened in the period get a legend entry.
  const shown = PARTS.filter((p) => (showAi || p.key === "team") && series.some((d) => dayParts(d, showAi)[p.key] > 0));

  const pick = (i: number | null) => {
    setActive(i);
    onHover(i === null ? null : series[i] ?? null);
  };
  const onKey = (e: KeyboardEvent) => {
    const last = n - 1;
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowRight"
        ? active === null ? last : Math.min(last, Math.max(0, active + (e.key === "ArrowRight" ? 1 : -1)))
        : e.key === "Home" ? 0
        : e.key === "End" ? last
        : e.key === "Escape" ? null
        : undefined;
    if (next === undefined) return;
    e.preventDefault();
    pick(next);
  };

  // Geometry, in CSS pixels.
  const W = Math.max(width, 1);
  const cy = HEIGHT / 2;
  const inner = Math.max(1, W - PAD * 2);
  const xOf = (i: number) => (n <= 1 ? W / 2 : PAD + (i * inner) / (n - 1));
  const half = (v: number) => (max === 0 ? 0 : (v / max) * (cy - EDGE));
  const onMove = (e: PointerEvent) => {
    if (n === 0) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = n <= 1 ? 0 : Math.round(((x - PAD) / inner) * (n - 1));
    const next = Math.min(n - 1, Math.max(0, i));
    if (next !== active) pick(next);
  };

  // Cumulative half-thickness from the centre out: AI resolved, + AI then team, + team only.
  const cum = series.map((d) => {
    const p = dayParts(d, showAi);
    return [p.aiResolved, p.aiResolved + p.aiThenTeam, d.conversations];
  });
  const layers = [0, 1, 2].map((k) => cum.map((c) => c[k]!));
  // One day has no neighbours to curve to: it tapers to nothing at both sides (a lens around its marker).
  const curves = layers.map((ys) => (n === 1 ? [0, ys[0]!, 0] : ys)).map((ys) => ({ ys, m: tangents(ys) }));

  // Sampled every 2px, held flat past the first and last day; each layer stays inside the next one out.
  const xs: number[] = [];
  for (let x = 0; x < W; x += 2) xs.push(x);
  xs.push(W);
  const uOf = (x: number) => (n <= 1 ? (x / W) * 2 : Math.min(n - 1, Math.max(0, ((x - PAD) / inner) * (n - 1))));
  const halves = xs.map((x) => {
    const u = uOf(x);
    const v = curves.map((c) => Math.max(0, at(c.ys, c.m, u)));
    v[1] = Math.max(v[1]!, v[0]!);
    v[2] = Math.max(v[2]!, v[1]!);
    return v.map(half);
  });
  const path = (k: number, minHalf = 0) => {
    const h = halves.map((v) => Math.max(minHalf, v[k]!));
    const top = xs.map((x, j) => `${x.toFixed(1)},${(cy - h[j]!).toFixed(1)}`);
    const bottom = xs.map((x, j) => `${x.toFixed(1)},${(cy + h[j]!).toFixed(1)}`).reverse();
    return `M${top.join("L")}L${bottom.join("L")}Z`;
  };

  // Markers: the busiest day and the last day while idle; the picked day alone while hovering.
  const busiest = totals.indexOf(max);
  const resting = empty ? [] : busiest === n - 1 || Math.abs(xOf(busiest) - xOf(n - 1)) < 72 ? [n - 1] : [busiest, n - 1];
  const markers = active === null ? resting : [active];
  const glowAt = xOf(busiestStretch(totals));

  // Axis: as many dates as fit, counted back from the last day so it always has one.
  const short = n <= 7;
  const fit = Math.max(1, Math.floor(W / LABEL_W));
  const every = Math.max(1, Math.ceil(n / fit));
  const labelLeft = (i: number) => Math.min(W - LABEL_W, Math.max(0, xOf(i) - LABEL_W / 2));

  const pill = (i: number, edge: "top" | "bottom") => {
    const d = series[i]!;
    const h = half(d.conversations);
    const y = edge === "top" ? cy - h : cy + h;
    const style = { left: Math.min(W - 22, Math.max(22, xOf(i))), top: Math.min(HEIGHT - 12, Math.max(12, y)) } as CSSProperties;
    if (edge === "top") return <span key={`t${i}`} className="ribbon-pill" style={style}>{d.conversations.toLocaleString()}</span>;
    return (
      <span key={`b${i}`} className="ribbon-pill part" style={style}>
        <i aria-hidden="true" />{d.aiResolved.toLocaleString()}<small>AI</small>
      </span>
    );
  };

  return (
    <div className="day-chart">
      {showAi && shown.length > 1 && (
        <div className="day-legend">
          {shown.map((p) => <span key={p.key}><i className={p.key} aria-hidden="true" />{p.label}</span>)}
        </div>
      )}
      <div
        ref={ref}
        className="ribbon"
        role="group"
        tabIndex={0}
        aria-label={empty ? "Conversations per day: none in this period." : "Conversations per day. Use the arrow keys to read each day."}
        onKeyDown={onKey}
        onPointerMove={onMove}
        onPointerLeave={() => pick(null)}
        onBlur={() => pick(null)}
        data-active={active !== null || undefined}
        data-solo={!showAi || undefined}
      >
        {width > 0 && n > 0 && (
          <>
            <svg width={W} height={HEIGHT} viewBox={`0 0 ${W} ${HEIGHT}`} aria-hidden="true">
              <defs>
                <radialGradient id="ribbon-glow">
                  <stop offset="0" stopColor="var(--stream-1)" stopOpacity="1" />
                  <stop offset="0.45" stopColor="var(--stream-1)" stopOpacity="0.4" />
                  <stop offset="1" stopColor="var(--stream-1)" stopOpacity="0" />
                </radialGradient>
              </defs>
              {!empty && <ellipse className="ribbon-glow" cx={glowAt} cy={cy} rx={Math.max(120, W * 0.32)} ry={HEIGHT * 0.62} fill="url(#ribbon-glow)" />}
              <line className="ribbon-axis" x1={0} x2={W} y1={cy} y2={cy} />
              <g className="ribbon-layers">
                <path className="team" d={path(2, 0.75)} />
                {showAi && <path className="aiThenTeam" d={path(1)} />}
                {showAi && <path className="aiResolved" d={path(0)} />}
              </g>
              {markers.map((i) => (
                <line key={i} className={`ribbon-marker${i === active ? " on" : ""}`} x1={xOf(i)} x2={xOf(i)} y1={4} y2={HEIGHT - 4} />
              ))}
            </svg>
            {/* A day without conversations has no edges apart: its one pill sits on the centre line. */}
            {!empty && markers.flatMap((i) => (showAi && series[i]!.conversations > 0 ? [pill(i, "top"), pill(i, "bottom")] : [pill(i, "top")]))}          </>
        )}
      </div>
      <div className="day-axis" aria-hidden="true">
        {width > 0 &&
          series.map((d, i) =>
            (n - 1 - i) % every === 0 || i === active ? (
              <span key={d.day} className={i === active ? "on" : ""} style={{ left: labelLeft(i) }}>
                {dayLabel(d.day, short ? { weekday: "short" } : { day: "numeric", month: "short" })}
              </span>
            ) : null,
          )}
      </div>
    </div>
  );
}
