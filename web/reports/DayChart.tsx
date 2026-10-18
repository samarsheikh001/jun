import { useState, type CSSProperties, type KeyboardEvent } from "react";
import type { DayPoint } from "../../shared/metrics.ts";

// A-01: conversations per day as stacked columns in the desk's own colours (plain HTML, no chart
// library). Bars, not an area: days are separate counts, and a line between them invents a trend.

const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });

type Part = "aiResolved" | "aiThenTeam" | "team";
const PARTS: { key: Part; label: string }[] = [
  { key: "aiResolved", label: "Resolved by the AI" },
  { key: "aiThenTeam", label: "AI, then the team" },
  { key: "team", label: "Team only" },
];

const parts = (d: DayPoint, showAi: boolean): Record<Part, number> =>
  showAi ? { aiResolved: d.aiResolved, aiThenTeam: d.ai - d.aiResolved, team: d.conversations - d.ai } : { aiResolved: 0, aiThenTeam: 0, team: d.conversations };

/** A round top for the axis (1, 2 or 5 × 10ⁿ steps) and its ticks, at most 4 steps. */
function scale(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

export default function DayChart({ series, showAi, onHover }: { series: DayPoint[]; showAi: boolean; onHover: (day: DayPoint | null) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const ticks = scale(Math.max(0, ...series.map((d) => d.conversations)));
  const top = ticks.at(-1)!;
  const short = series.length <= 7;
  const every = short ? 1 : Math.ceil(series.length / 8);
  // Only the parts that happened in the period get a legend entry.
  const shown = PARTS.filter((p) => (showAi || p.key === "team") && series.some((d) => parts(d, showAi)[p.key] > 0));

  const pick = (i: number | null) => {
    setActive(i);
    onHover(i === null ? null : series[i] ?? null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const last = series.length - 1;
    pick(active === null ? last : Math.min(last, Math.max(0, active + (e.key === "ArrowRight" ? 1 : -1))));
  };

  return (
    <div className="day-chart">
      {showAi && shown.length > 1 && (
        <div className="day-legend">
          {shown.map((p) => <span key={p.key}><i className={p.key} aria-hidden="true" />{p.label}</span>)}
        </div>
      )}
      <div className="day-plot">
        <div className="day-ticks" aria-hidden="true">
          {ticks.map((t) => <span key={t} data-n={t.toLocaleString()} style={{ "--at": t / top } as CSSProperties} />)}
        </div>
        <div
          className="day-cols"
          role="group"
          tabIndex={0}
          aria-label="Conversations per day. Use the arrow keys to read each day."
          onKeyDown={onKey}
          onMouseLeave={() => pick(null)}
          onBlur={() => pick(null)}
          data-active={active !== null || undefined}
        >
          {series.map((d, i) => {
            const p = parts(d, showAi);
            return (
              <div key={d.day} className={`day-col${i === active ? " on" : ""}`} onMouseEnter={() => pick(i)}>
                <div className="day-stack" style={{ "--h": d.conversations / top } as CSSProperties}>
                  {(["team", "aiThenTeam", "aiResolved"] as const).map((k) =>
                    p[k] > 0 ? <i key={k} className={k} style={{ flexGrow: p[k] }} /> : null,
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="day-axis" aria-hidden="true">
        {series.map((d, i) => (
          <span key={d.day} className={i === active ? "on" : ""}>
            {(series.length - 1 - i) % every === 0 ? dayLabel(d.day, short ? { weekday: "short" } : { day: "numeric", month: "short" }) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
