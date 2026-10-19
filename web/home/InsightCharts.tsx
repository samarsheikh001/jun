import { useState, type KeyboardEvent } from "react";
import type { StepChart } from "../../shared/desk-assistant.ts";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { ChartColumnIcon } from "@/components/icons.tsx";
import { DeskLink } from "./DeskLink.tsx";

// D-134, after beautifului.dev's Insight Cards (patterns only), drawn like Reports (D-106, D-125: plain
// HTML/CSS in the desk's tokens, the AI in the --stream-* blues, numbers in Geist Mono): Reports'
// numbers a step read, as a small chart under the turn. Chats per day are bars (resolved by the AI,
// the rest of the AI's, the team's), with a readout of the day under the pointer or the arrow keys;
// topics and handoff reasons are ranked bars, a topic linking to its chats.

type Days = Extract<StepChart, { kind: "days" }>;
type Ranked = Extract<StepChart, { kind: "ranked" }>;

const dayLabel = (day: string, long = false) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], { timeZone: "UTC", ...(long ? { weekday: "short" } : {}), month: "short", day: "numeric" });

function DayBars({ chart }: { chart: Days }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...chart.series.map((d) => d.chats));
  const d = active === null ? null : chart.series[active]!;
  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const last = chart.series.length - 1;
    setActive((a) => (e.key === "Home" ? 0 : e.key === "End" ? last : a === null ? last : Math.max(0, Math.min(last, a + (e.key === "ArrowRight" ? 1 : -1)))));
  };
  const change = chart.change === null ? null : chart.change === 0 ? "unchanged" : `${chart.change > 0 ? "+" : "−"}${Math.abs(chart.change)}%`;
  return (
    <div className="ins-card">
      <div className="ins-top">
        <span className="ins-big">{chart.total}</span>
        <span className="ins-unit">chats · last {chart.days} days</span>
        {change && <span className={`ins-change${chart.change! > 0 ? " up" : chart.change! < 0 ? " down" : ""}`} title="Against the period before">{change}</span>}
      </div>
      <p className="ins-readout" aria-live="polite">
        {d ? (
          <>
            <span className="ins-day">{dayLabel(d.day, true)}</span> <span className="ins-num">{d.chats}</span> chat{d.chats === 1 ? "" : "s"} · <span className="ins-num">{d.ai}</span> with the AI · <span className="ins-num">{d.aiResolved}</span> resolved by it
          </>
        ) : (
          <span className="ins-legend">
            <i className="r" /> resolved by AI <i className="a" /> AI, then team <i className="t" /> team
          </span>
        )}
      </p>
      <div
        className="ins-bars"
        role="img"
        tabIndex={0}
        aria-label={`Chats per day, ${dayLabel(chart.series[0]!.day)} to ${dayLabel(chart.series.at(-1)!.day)}; arrow keys read each day`}
        onKeyDown={move}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {chart.series.map((s, i) => {
          const team = Math.max(0, s.chats - s.ai);
          const aiRest = Math.max(0, s.ai - s.aiResolved);
          return (
            <span key={s.day} className={`ins-bar${active === i ? " on" : ""}`} onPointerEnter={() => setActive(i)}>
              <span className="ins-stack" style={{ height: `${(s.chats / max) * 100}%` }}>
                {team > 0 && <span className="t" style={{ flexGrow: team }} />}
                {aiRest > 0 && <span className="a" style={{ flexGrow: aiRest }} />}
                {s.aiResolved > 0 && <span className="r" style={{ flexGrow: s.aiResolved }} />}
              </span>
            </span>
          );
        })}
      </div>
      <div className="ins-axis" aria-hidden="true">
        <span>{dayLabel(chart.series[0]!.day)}</span>
        <span>{dayLabel(chart.series.at(-1)!.day)}</span>
      </div>
    </div>
  );
}

function RankedRows({ chart }: { chart: Ranked }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...chart.rows.map((r) => r.value));
  const detail = active === null ? null : chart.rows[active]!;
  return (
    <div className="ins-card">
      <p className="ins-title">{chart.title}</p>
      <ul className="ins-ranked" onPointerLeave={() => setActive(null)}>
        {chart.rows.map((r, i) => {
          const body = (
            <>
              <span className="ins-label" title={r.label}>{r.label}</span>
              <span className="ins-track">
                <span className="ins-fill" style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} />
              </span>
              <span className="ins-num">{r.value}</span>
            </>
          );
          const props = { className: `ins-row${i === 0 ? " lead" : ""}${active === i ? " on" : ""}`, onPointerEnter: () => setActive(i), onFocus: () => setActive(i), onBlur: () => setActive(null) };
          return (
            <li key={r.label}>
              {r.href ? (
                <DeskLink href={r.href} {...props} title={`${r.label}: open these chats`}>
                  {body}
                </DeskLink>
              ) : (
                <span {...props} tabIndex={0}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {detail?.detail && (
        <p className="ins-detail">
          <span className="ins-day">{detail.label}</span> · {detail.detail}
        </p>
      )}
    </div>
  );
}

/** The charts of one turn's steps, folding together. */
export function InsightCharts({ charts }: { charts: StepChart[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="ins">
      <button type="button" data-plain className="rec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rec-head-icon" aria-hidden="true"><ChartColumnIcon /></span>
        <span>{charts.map((c) => (c.kind === "days" ? "Chats per day" : c.title)).join(" · ")}</span>
        <Chevron open={open} />
      </button>
      <Fold open={open}>
        <div className="ins-list">{charts.map((c, i) => (c.kind === "days" ? <DayBars key={i} chart={c} /> : <RankedRows key={i} chart={c} />))}</div>
      </Fold>
    </div>
  );
}
