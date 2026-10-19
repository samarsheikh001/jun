import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TagIcon } from "@/components/icons";
import type { InsightPart } from "../lib/topic-insight.ts";

// D-125 / D-126: the parts Top topics and Top handoff reasons share: the written line, the left
// column's stats, the hover state and the floating card beside a bar (styles: .tt-* in desk.css).

/** The written line beside the bars: names and numbers emphasised, the lead in its bar's strong blue. */
export function Insight({ parts }: { parts: InsightPart[] }) {
  return (
    <p className="tt-insight">
      {parts.map((p, i) =>
        typeof p === "string" ? p
          : "strong" in p ? <span key={i} className="tt-em">{p.strong}</span>
            : <span key={i} className={p.lead ? "tt-em tt-lead" : "tt-em"}>{p.lead && <i aria-hidden="true" />}{p.topic}</span>,
      )}
    </p>
  );
}

/** One of the left column's stats: a faint icon, the number in mono, a muted label. */
export function BarStat({ icon: Icon, value, label, hint }: { icon: typeof TagIcon; value: string; label: string; hint?: string }) {
  return (
    <div className="tt-stat" title={hint}>
      <Icon className="tt-stat-icon" />
      <dd>{value}</dd>
      <dt>{label}</dt>
    </div>
  );
}

/** The hovered or focused row's id, and the handlers a row spreads to set it. */
export function useActiveRow() {
  const [active, setActive] = useState<string | null>(null);
  const hover = (id: string) => ({
    onPointerEnter: () => setActive(id),
    onPointerLeave: () => setActive((a) => (a === id ? null : a)),
    onFocus: () => setActive(id),
    onBlur: () => setActive((a) => (a === id ? null : a)),
  });
  return { active, hover };
}

/** The active row's card, kept inside the bars' box (right of the count, else under or over the row). */
export function BarCard({ box, active, children }: { box: HTMLDivElement | null; active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    const li = box?.querySelector<HTMLElement>(`[data-row="${CSS.escape(active)}"]`);
    const end = li?.querySelector<HTMLElement>(".tt-value");
    const fill = li?.querySelector<HTMLElement>(".tt-fill");
    if (!box || !card || !end || !fill) return;
    const b = box.getBoundingClientRect();
    const e = end.getBoundingClientRect();
    const f = fill.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const right = e.right - b.left + 12;
    if (right + w <= b.width) {
      const mid = f.top + f.height / 2 - b.top;
      setAt({ left: right, top: Math.max(0, Math.min(mid - h / 2, b.height - h)) });
      return;
    }
    // No room beside the bar: under the row (over it near the box's bottom), ending at the count.
    const below = f.bottom - b.top + 12;
    const above = f.top - b.top - 12 - h;
    setAt({ left: Math.max(0, Math.min(e.right - b.left - w, b.width - w)), top: below + h <= b.height || above < 0 ? below : above });
  }, [box, active]);
  return (
    <div ref={ref} className="tt-card" role="tooltip" style={at ? { left: at.left, top: at.top } : { visibility: "hidden" }}>
      {children}
    </div>
  );
}
