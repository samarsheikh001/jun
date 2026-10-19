import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { deskHref, navigate } from "../lib/router.ts";
import { chatScale, FIELD_BLOBS, labelWidth, mapHues, placeLabels, shortLabel, spreadDots, type MapTopic } from "../lib/topic-map.ts";

// D-120: the topic map. One dot per topic: x = its chats (log when they spread widely), y = the share
// of its AI chats the AI resolved alone (computeMetrics' rate). Behind the dots a grainy rainbow field
// (blurred blobs + feTurbulence grain), laid out by meaning (web/lib/topic-map.ts FIELD_BLOBS); each
// dot takes the hue under it (mapHues). Plain SVG at the measured width. A dot opens the inbox on its topic.

const pct = (r: number) => `${Math.round(r * 100)}%`;

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

/**
 * Measures a label in the font `.tm-dot text` draws it with (desk.css: 500 12px var(--font-mono)),
 * plus its 3px halo stroke; falls back to the estimate without a canvas. Re-measures once the web
 * fonts have loaded (`fontsReady` bumps).
 */
function useMeasure() {
  const [fontsReady, setFontsReady] = useState(0);
  useLayoutEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFontsReady((n) => n + 1)).catch(() => {});
    return () => { live = false; };
  }, []);
  return useMemo(() => {
    void fontsReady; // a new measure once the fonts are in
    const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (!ctx) return labelWidth;
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    ctx.font = `500 12px ${family}`;
    return (text: string) => Math.ceil(ctx.measureText(text).width + 3);
  }, [fontsReady]);
}

const M = { top: 14, right: 14, bottom: 46, left: 58 };

export default function TopicMap({ topics }: { topics: MapTopic[] }) {
  const [ref, width] = useWidth();
  const measure = useMeasure();
  const [active, setActive] = useState<string | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const narrow = width > 0 && width < 560;
  const height = narrow ? 340 : 440;
  const pw = Math.max(0, width - M.left - M.right);
  const ph = height - M.top - M.bottom;
  const scale = useMemo(() => chatScale(topics.map((t) => t.count), narrow ? 3 : 7), [topics, narrow]);

  // Colours from the plot position on the wide scale (mapHues), so a dot's colour never changes with the screen.
  const hues = useMemo(() => mapHues(topics), [topics]);
  const dots = useMemo(() => {
    // Biggest first: they get the first pick of label places.
    const sorted = [...topics].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const placed = spreadDots(sorted.map((t) => ({ t, x: scale.at(t.count) * pw, y: (1 - t.rate) * ph })));
    const sides = placeLabels(placed.map((d) => ({ id: d.t.id, x: d.x, y: d.y, w: measure(shortLabel(d.t.name)) })), pw, ph);
    return placed.map((d) => ({ ...d, hue: hues.get(d.t.id) ?? 0, label: sides.get(d.t.id) ?? null }));
  }, [topics, scale, pw, ph, measure, hues]);

  const shown = dots.find((d) => d.t.id === active) ?? null;
  const size = Math.min(pw, ph);
  const go = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    navigate(`/inbox?topic=${encodeURIComponent(id)}`);
  };
  const yTicks = narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const tickLabel = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v));

  return (
    <div className="topic-map" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label="Topic map: chats per topic against the share the AI resolved">
          <defs>
            <filter id={`${uid}-grain`} x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation={Math.max(18, size * 0.11)} result="soft" />
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" result="noise" />
              <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 -1.5" result="speckle" />
              <feComposite in="soft" in2="speckle" operator="in" result="grainy" />
              <feComposite in="soft" in2="grainy" operator="arithmetic" k1="0" k2="0.55" k3="0.7" k4="0" />
            </filter>
            {/* The field fades out just past the plot's edges, never into the page around it. */}
            <filter id={`${uid}-soft`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation={Math.max(14, size * 0.06)} />
            </filter>
            <mask id={`${uid}-fade`} maskUnits="userSpaceOnUse" x={-M.left} y={-M.top} width={width} height={height}>
              <rect x={pw * 0.02} y={ph * 0.02} width={pw * 0.96} height={ph * 0.96} rx={24} fill="white" filter={`url(#${uid}-soft)`} />
            </mask>
          </defs>
          <g transform={`translate(${M.left} ${M.top})`}>
            <g mask={`url(#${uid}-fade)`} aria-hidden="true"><g className="tm-field" filter={`url(#${uid}-grain)`}>
              {FIELD_BLOBS.map((b, i) => (
                <ellipse key={i} cx={b.x * pw} cy={(1 - b.y) * ph} rx={b.r * pw * 0.8} ry={b.r * ph * 0.9} style={{ "--h": b.hue } as CSSProperties} />
              ))}
            </g></g>
            <g className="tm-grid" aria-hidden="true">
              {scale.ticks.map((t) => (
                <g key={`x${t}`}>
                  <line x1={scale.at(t) * pw} x2={scale.at(t) * pw} y1={0} y2={ph} />
                  <text x={scale.at(t) * pw} y={ph + 16} textAnchor="middle">{tickLabel(t)}</text>
                </g>
              ))}
              {yTicks.map((t) => (
                <g key={`y${t}`}>
                  <line x1={0} x2={pw} y1={(1 - t) * ph} y2={(1 - t) * ph} />
                  <text x={-8} y={(1 - t) * ph + 4} textAnchor="end">{pct(t)}</text>
                </g>
              ))}
            </g>
            <g className="tm-axis" aria-hidden="true">
              <text x={0} y={ph + 38}>← Fewer chats</text>
              <text x={pw} y={ph + 38} textAnchor="end">More chats →</text>
              <text transform={`translate(${-44} ${ph}) rotate(-90)`}>← Needs a person</text>
              <text transform={`translate(${-44} 0) rotate(-90)`} textAnchor="end">AI resolves →</text>
            </g>
            <g className="tm-dots">
              {dots.map((d, i) => {
                const label = shortLabel(d.t.name);
                const side = d.label?.side;
                const ly = side === "above" ? d.y - 12 : side === "below" ? d.y + 18 : d.y + 4;
                const anchor = side === "left" ? "end" : side === "right" ? "start" : "middle";
                return (
                  <a
                    key={d.t.id}
                    href={deskHref(`/inbox?topic=${encodeURIComponent(d.t.id)}`)}
                    onClick={go(d.t.id)}
                    className={`tm-dot${active === d.t.id ? " on" : ""}`}
                    style={{ "--h": d.hue, "--i": i } as CSSProperties}
                    aria-label={`${d.t.name}: ${d.t.count} chats, AI resolved ${pct(d.t.rate)}, ${d.t.handedOff} handed over. Open in the inbox`}
                    onPointerEnter={() => setActive(d.t.id)}
                    onPointerLeave={() => setActive((a) => (a === d.t.id ? null : a))}
                    onFocus={() => setActive(d.t.id)}
                    onBlur={() => setActive((a) => (a === d.t.id ? null : a))}
                  >
                    <circle className="tm-hit" cx={d.x} cy={d.y} r={12} />
                    <circle className="tm-mark" cx={d.x} cy={d.y} r={5} />
                    {d.label && <text x={d.label.x} y={ly} textAnchor={anchor}>{label}</text>}
                  </a>
                );
              })}
            </g>
          </g>
        </svg>
      )}
      {shown && (
        <div
          className={`tm-tip${shown.x > pw / 2 ? " flip" : ""}`}
          style={{ left: M.left + shown.x, top: M.top + shown.y } as CSSProperties}
          role="tooltip"
        >
          <span className="tm-tip-name"><i style={{ "--h": shown.hue } as CSSProperties} />{shown.t.name}</span>
          <span className="tm-tip-row"><span>Chats</span><b>{shown.t.count.toLocaleString()}</b></span>
          <span className="tm-tip-row"><span>AI resolved</span><b>{pct(shown.t.rate)}</b></span>
          <span className="tm-tip-row"><span>Handed over</span><b>{shown.t.handedOff.toLocaleString()}</b></span>
          <span className="tm-tip-foot">{shown.t.aiResolved} of {shown.t.ai} AI chats resolved alone · click to open</span>
        </div>
      )}
    </div>
  );
}
