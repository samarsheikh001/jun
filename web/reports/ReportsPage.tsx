import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ArrowDownIcon as ArrowDown, ArrowRightIcon as ArrowRight, ArrowUpIcon as ArrowUp, BotIcon, ChatIcon, HandoffIcon, TagIcon, ThumbsDownIcon, ThumbsUpIcon } from "@/components/icons";
import { formatDuration, MAX_METRIC_CONVERSATIONS, METRIC_PERIODS, type DayPoint, type MetricPeriod, type MetricsReport, type TopicCount } from "../../shared/metrics.ts";
import { api, describeError } from "../api.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { mapTopics, MIN_MAP_TOPICS, type MapTopic } from "../lib/topic-map.ts";
import { topicInsight, type InsightPart } from "../lib/topic-insight.ts";
import DayChart from "./DayChart.tsx";
import { StartPages, Struggles } from "./PageSections.tsx";
import TopicMap from "./TopicMap.tsx";
import { TopicsPanel } from "./TopicsPanel.tsx";

// A-01: core metrics. Days are calendar days in the browser's time zone; the Worker
// aggregates and shared/metrics.ts defines every number (see docs/features.md A-01, A-06).

const timezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const percent = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const duration = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));
const dayLabel = (key: string, weekday = false) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", ...(weekday ? { weekday: "short" } : {}) });

/**
 * A headline number: label (its definition on hover), the value in mono, a change or detail under it.
 * No value yet is a quiet dash, never a word set as big as a number.
 */
function Kpi({ label, hint, value, change, detail }: { label: string; hint: string; value: string | null; change?: ReactNode; detail: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label" title={hint}>{label}</div>
      <div className={`kpi-value${value === null ? " none" : ""}`}>{value ?? "–"}</div>
      <div className="kpi-detail">{change}<span>{detail}</span></div>
    </div>
  );
}

/** CSAT in full: the good/bad split and the latest bad ratings' comments, as quotes that open their chat. */
function Ratings({ csat }: { csat: MetricsReport["csat"] }) {
  const total = csat.good + csat.bad;
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Ratings</h2>
        {total > 0 && <span className="dash-caption nums">{total.toLocaleString()} rating{total === 1 ? "" : "s"}</span>}
      </div>
      {total === 0 ? (
        <p className="muted small">
          No ratings in this period. When a chat ends, visitors can rate it good or bad and add a comment; comments on bad ratings show up here.
        </p>
      ) : (
        <>
          <div className="ratings-split">
            <div className="ratings-side good"><ThumbsUpIcon /><span className="ratings-n">{csat.good.toLocaleString()}</span> {percent(csat.good / total)}</div>
            <div className="ratings-side bad">{percent(csat.bad / total)} <span className="ratings-n">{csat.bad.toLocaleString()}</span><ThumbsDownIcon /></div>
          </div>
          <div className="ratings-bar" style={{ "--split": csat.good / total } as CSSProperties} role="img" aria-label={`${csat.good} good, ${csat.bad} bad`} />
          <h3 className="ratings-sub">Comments on bad ratings</h3>
          {csat.badComments.length === 0 ? (
            <p className="muted small">{csat.bad === 0 ? "No bad ratings in this period." : "None of the bad ratings came with a comment."}</p>
          ) : (
            <ul className="quotes">
              {csat.badComments.map((x) => (
                <li key={`${x.conversationId}:${x.createdAt}`}>
                  <a href={deskHref(`/inbox/${x.conversationId}`)} onClick={goTo(`/inbox/${x.conversationId}`)}>
                    <span className="quote-text">{x.comment}</span>
                    <span className="quote-meta">{new Date(x.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · Open chat →</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The change against the period before; null without one to compare against. */
function Change({ change, days }: { change: number | null; days: number }) {
  if (change === null) return null;
  const pct = Math.round(Math.abs(change) * 1000) / 10;
  const dir = pct === 0 ? "flat" : change > 0 ? "up" : "down";
  const Icon = dir === "flat" ? ArrowRight : dir === "up" ? ArrowUp : ArrowDown;
  return (
    <span className={`kpi-change ${dir}`} title={`Against the ${days} days before`}>
      <Icon aria-hidden="true" />
      {dir === "flat" ? "0%" : `${pct}%`}
    </span>
  );
}

const goTo = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  navigate(path);
};

/** Topics Top topics names as bars; the rest are one Other row (never an Other of one topic). */
const MAX_TOPICS_SHOWN = 7;

/** The Manage topics sheet's address (D-120); Settings → Inbox and the command palette link here. */
const TOPICS_SHEET_PATH = "/dashboard/topics";
const openTopics = () => navigate(TOPICS_SHEET_PATH, { replace: true });

/** The written line beside the bars (D-123): topic names and numbers emphasised, the top topic in its bar's strong blue. */
function Insight({ parts }: { parts: InsightPart[] }) {
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
function TopicStat({ icon: Icon, value, label, hint }: { icon: typeof TagIcon; value: string; label: string; hint?: string }) {
  return (
    <div className="tt-stat" title={hint}>
      <Icon className="tt-stat-icon" />
      <dd>{value}</dd>
      <dt>{label}</dt>
    </div>
  );
}

/** A bar row: a topic, or Other (`rest` set). */
type TopicRow = { id: string; name: string; count: number; topic: TopicCount | null; rest?: TopicCount[] };

/** The hovered or focused row's card: its numbers, kept inside the bars' box (right of the count, else under or over the row). */
function TopicCard({ row, labeled, showAi, box, active }: { row: TopicRow; labeled: number; showAi: boolean; box: HTMLDivElement | null; active: string }) {
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
  const t = row.topic;
  const share = (n: number, of: number) => `${n.toLocaleString()} (${percent(of > 0 ? n / of : null)})`;
  return (
    <div ref={ref} className="tt-card" role="tooltip" style={at ? { left: at.left, top: at.top } : { visibility: "hidden" }}>
      <span className="tt-card-name">{row.name}</span>
      <span className="tt-card-row"><span>Chats</span><b>{share(row.count, labeled)}</b></span>
      {t && showAi && (t.ai > 0 ? (
        <>
          <span className="tt-card-row"><span>Resolved by AI</span><b>{share(t.aiResolved, t.ai)}</b></span>
          <span className="tt-card-row"><span>Handed off</span><b>{share(t.handedOff, t.ai)}</b></span>
        </>
      ) : <span className="tt-card-foot">No AI chats in this topic</span>)}
      {row.rest ? (
        <span className="tt-card-foot">{row.rest.map((r) => r.name).join(", ")}</span>
      ) : (
        <span className="tt-card-foot open">Open in inbox <ArrowRight /></span>
      )}
    </div>
  );
}

/**
 * A-02: what visitors ask about, from the AI's topic labels (D-125, after a ranked-bar reference): the
 * written line and a few stats on the left, one bar per topic on the right in one blue (the top topic
 * and the hovered or focused row strong, the rest soft, Other grey). Hovering or focusing a row shows
 * its card; a row opens the inbox filtered by the topic. `manage`: the Manage topics button sits here
 * when there's no topic map above.
 */
function TopTopics({ topics, showAi, aiEnabled, manage, mapNote }: { topics: MetricsReport["topics"]; showAi: boolean; aiEnabled: boolean; manage: boolean; mapNote: string | null }) {
  const [active, setActive] = useState<string | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const shown = topics.list.length <= MAX_TOPICS_SHOWN + 1 ? topics.list.length : MAX_TOPICS_SHOWN;
  const rest = topics.list.slice(shown);
  const rows: TopicRow[] = topics.list.slice(0, shown).map((t) => ({ id: t.id, name: t.name, count: t.count, topic: t }));
  if (rest.length > 0) rows.push({ id: "other", name: `Other · ${rest.length} topics`, count: rest.reduce((s, t) => s + t.count, 0), topic: null, rest });
  const max = Math.max(1, ...rows.map((r) => r.count));
  const insight = topicInsight(topics.list, topics.labeled, showAi);
  // The AI's numbers across the labelled topics it answered in (the headline counts every AI chat).
  const ai = topics.list.reduce((s, t) => ({ chats: s.chats + t.ai, resolved: s.resolved + t.aiResolved, handedOff: s.handedOff + t.handedOff }), { chats: 0, resolved: 0, handedOff: 0 });
  const href = (id: string) => `/inbox?topic=${encodeURIComponent(id)}`;
  const hover = (id: string) => ({
    onPointerEnter: () => setActive(id),
    onPointerLeave: () => setActive((a) => (a === id ? null : a)),
    onFocus: () => setActive(id),
    onBlur: () => setActive((a) => (a === id ? null : a)),
  });
  const activeRow = rows.find((r) => r.id === active) ?? null;
  return (
    <section className="dash-card top-topics">
      <div className="dash-card-head">
        <h2>Top topics</h2>
        {manage && <Button variant="outline" size="sm" onClick={openTopics}>Manage topics</Button>}
      </div>
      {rows.length === 0 ? (
        <p className="muted small">
          {!aiEnabled ? (
            <>
              The AI assistant labels each chat with a short topic, like Billing or Login, and AI replies are off.{" "}
              <a href={deskHref("/settings/ai")} onClick={goTo("/settings/ai")}>Turn it on</a>
            </>
          ) : topics.unlabeled > 0
            ? "Topics appear after chats go quiet for a few minutes: the AI gives each one a short label, like Billing or Login."
            : "No chats in this period yet. Topics appear after chats go quiet for a few minutes."}
        </p>
      ) : (
        <>
          <div className="tt-layout">
            <div className="tt-side">
              {insight && <Insight parts={insight} />}
              <dl className="tt-stats">
                <TopicStat icon={TagIcon} value={topics.list.length.toLocaleString()} label={topics.list.length === 1 ? "Topic" : "Topics"} />
                <TopicStat icon={ChatIcon} value={topics.labeled.toLocaleString()} label="Labelled chats" />
                {showAi && ai.chats > 0 && (
                  <>
                    <TopicStat icon={BotIcon} value={percent(ai.resolved / ai.chats)} label="Resolved by the AI" hint={`${ai.resolved} of the ${ai.chats} AI chats in these topics, resolved alone`} />
                    <TopicStat icon={HandoffIcon} value={ai.handedOff.toLocaleString()} label="Handed off" hint={`${percent(ai.handedOff / ai.chats)} of the ${ai.chats} AI chats in these topics went to the team`} />
                  </>
                )}
              </dl>
            </div>
            <div className="tt-bars" ref={setBox}>
              <ol className="tt-rows">
                {rows.map((r, i) => {
                  const cls = `tt-row${i === 0 && r.topic ? " lead" : ""}${r.rest ? " other" : ""}${active === r.id ? " on" : ""}`;
                  const inner = (
                    <>
                      <span className="tt-label" title={r.rest ? r.rest.map((x) => x.name).join(", ") : r.name}>{r.name}</span>
                      <span className="tt-track">
                        <span className="tt-fill"><span className="tt-share">{percent(r.count / topics.labeled)}</span></span>
                        <span className="tt-value">{r.count.toLocaleString()}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={r.id} data-row={r.id} style={{ "--w": r.count / max } as CSSProperties}>
                      {r.topic ? (
                        <a className={cls} href={deskHref(href(r.id))} onClick={goTo(href(r.id))} aria-label={`${r.name}: ${r.count.toLocaleString()} chats, ${percent(r.count / topics.labeled)} of labelled chats. Open in inbox`} {...hover(r.id)}>{inner}</a>
                      ) : (
                        <div className={cls} {...hover(r.id)}>{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
              {activeRow && <TopicCard key={activeRow.id} row={activeRow} labeled={topics.labeled} showAi={showAi} box={box} active={activeRow.id} />}
            </div>
          </div>
          <p className="dash-foot">
            Bars are chats per topic; the pill is the topic's share of the {topics.labeled.toLocaleString()} labelled chats. Hover or focus a topic for its numbers.
            {!aiEnabled && " New chats aren't labelled while AI replies are off."}
            {aiEnabled && topics.unlabeled > 0 && ` ${topics.unlabeled} chat${topics.unlabeled === 1 ? " isn't" : "s aren't"} labelled yet (still going, or quiet for less than a few minutes).`}
          </p>
          {mapNote && <p className="dash-foot">{mapNote}</p>}
        </>
      )}
    </section>
  );
}

/** Top topics while the report loads: the same columns and rows, the bars as skeletons. */
function TopTopicsSkeleton() {
  return (
    <section className="dash-card top-topics" aria-hidden="true">
      <div className="dash-card-head"><h2>Top topics</h2></div>
      <div className="tt-layout">
        <div className="tt-side">
          <p className="tt-insight"><SkelText width="100%" /><br /><SkelText width="60%" /></p>
          <dl className="tt-stats">
            {["Topics", "Labelled chats"].map((label) => (
              <div key={label} className="tt-stat"><span className="tt-stat-icon" /><dd><SkelText width="3ch" /></dd><dt>{label}</dt></div>
            ))}
          </dl>
        </div>
        <div className="tt-bars">
          <ol className="tt-rows">
            {[1, 0.72, 0.55, 0.4, 0.3].map((w, i) => (
              <li key={i} style={{ "--w": w } as CSSProperties}>
                <div className="tt-row"><span className="tt-label"><SkelText width={90} /></span><span className="tt-track"><span className="tt-fill skel" /></span></div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** D-120: the topic map, with the Manage topics button in its header. Shown from MIN_MAP_TOPICS topics with AI chats. */
function TopicMapSection({ topics, mapped }: { topics: MetricsReport["topics"]; mapped: MapTopic[] }) {
  const left = topics.list.length - mapped.length;
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <div className="topic-map-head">
          <h2>Topic map</h2>
          <span className="dash-caption">Each dot is a topic: how many chats it had, and how many of its AI chats the AI resolved alone.</span>
        </div>
        <Button variant="outline" size="sm" onClick={openTopics}>Manage topics</Button>
      </div>
      <TopicMap topics={mapped} />
      <p className="dash-foot">
        Hover or focus a dot for its numbers; click it to open its chats in the inbox. Warm colours mark busy topics the AI rarely finishes, green and yellow the ones it does.
        {left > 0 && ` ${left} topic${left === 1 ? " has" : "s have"} no AI chats and ${left === 1 ? "isn't" : "aren't"} on the map.`}
      </p>
    </section>
  );
}

/** The line over the chart: the picked day and its split, else the busiest day. Always the same height. */
function DayReadout({ day, series, showAi }: { day: DayPoint | null; series: DayPoint[]; showAi: boolean }) {
  const busiest = series.reduce<DayPoint | null>((b, d) => (d.conversations > (b?.conversations ?? 0) ? d : b), null);
  const d = day ?? busiest;
  return (
    <p className="day-readout" aria-live="polite">
      {!d ? (
        "No conversations in this period"
      ) : (
        <>
          <span className="strong">{day ? dayLabel(d.day, true) : `Busiest: ${dayLabel(d.day, true)}`}</span>
          {` · ${d.conversations.toLocaleString()} conversation${d.conversations === 1 ? "" : "s"}`}
          {showAi && d.conversations > 0 && (
            <span className="day-readout-split">
              {` · ${d.aiResolved.toLocaleString()} resolved by the AI · ${(d.ai - d.aiResolved).toLocaleString()} AI, then the team · ${(d.conversations - d.ai).toLocaleString()} team only`}
            </span>
          )}
        </>
      )}
    </p>
  );
}

/** A-01's headline card: the conversations stream over the headline numbers. */
function Overview({ r }: { r: MetricsReport }) {
  const [day, setDay] = useState<DayPoint | null>(null);
  const showAi = !r.ai.off;
  const value = (n: number | null, format: (n: number) => string) => (n === null ? null : format(n));
  const prev = r.conversations.previousTotal;
  const aiFirst = r.ai.firstResponse.median === null ? "" : ` The AI's first answer takes ${duration(r.ai.firstResponse.median)} (median).`;
  // Only what changes how to read the numbers; the definitions are on the labels.
  const notes = [
    !r.ai.off && !r.ai.enabled && "AI replies are off now; the AI numbers are from earlier in the period.",
    !r.ai.off && r.ai.passedWhileOff > 0 &&
      `${r.ai.passedWhileOff} chat${r.ai.passedWhileOff === 1 ? "" : "s"} reached the AI while it was off and went to the team; ${r.ai.passedWhileOff === 1 ? "it isn't" : "they aren't"} counted as handoffs.`,
  ].filter(Boolean);
  return (
    <section className="dash-card dash-hero">
      <div className="conv-head">
        <h2>Conversations</h2>
        <div className="conv-total">
          <span className="kpi-value" title={`Conversations started in the last ${r.days} days.`}>{r.conversations.total.toLocaleString()}</span>
          <Change change={r.conversations.change} days={r.days} />
        </div>
        <p className="conv-compare">
          {prev === null ? "" : prev === 0 ? `None the ${r.days} days before · ` : `Compared to ${prev.toLocaleString()} the ${r.days} days before · `}
          {r.conversations.resolved.toLocaleString()} marked resolved
        </p>
      </div>
      <DayReadout day={day} series={r.conversations.series} showAi={showAi} />
      <DayChart key={r.days} series={r.conversations.series} showAi={showAi} onHover={setDay} />
      <div className="kpis">
        {r.ai.off ? (
          <Kpi
            label="AI assistant"
            hint="AI replies are off, and none of this period's chats were the AI's."
            value={null}
            detail={<>Off. <a href={deskHref("/settings/ai")} onClick={goTo("/settings/ai")}>Turn it on</a></>}
          />
        ) : (
          <>
            <Kpi
              label="AI resolved"
              hint="Of the chats the AI answered, the ones it finished alone: no handoff and no reply from the team."
              value={value(r.ai.resolutionRate, percent)}
              detail={`${r.ai.resolved} of ${r.ai.conversations} AI chats`}
            />
            <Kpi
              label="Handed off"
              hint="Of the chats the AI answered, the ones it passed to the team."
              value={value(r.ai.handoffRate, percent)}
              detail={`${r.ai.handedOff} of ${r.ai.conversations} AI chats`}
            />
          </>
        )}
        <Kpi
          label="First response"
          hint={`The median time from a visitor's first message to the team's first reply.${aiFirst}`}
          value={value(r.team.firstResponse.median, duration)}
          detail={r.team.firstResponse.p90 === null ? "No team replies yet" : `90% within ${duration(r.team.firstResponse.p90)}`}
        />
        <Kpi
          label="CSAT"
          hint="Good ratings out of all ratings given in this period."
          value={value(r.csat.score, percent)}
          detail={r.csat.good + r.csat.bad === 0 ? "No ratings yet" : `${r.csat.good} good · ${r.csat.bad} bad`}
        />
      </div>
      {notes.length > 0 && <p className="dash-foot">{notes.join(" ")}</p>}
    </section>
  );
}

/** The last report per workspace and period: coming back shows it at once while a fresh one loads. */
const reportCache = new Map<string, MetricsReport>();

/** The loading page: the hero card's own parts and sizes, so the report drops in without moving anything. */
function DashboardSkeleton({ aiOff }: { aiOff: boolean }) {
  const kpis = aiOff ? ["AI assistant", "First response", "CSAT"] : ["AI resolved", "Handed off", "First response", "CSAT"];
  return (
    // A fragment: the sections sit straight in the page, with its gaps, like the real ones.
    <>
      <section className="dash-card dash-hero" aria-busy="true" aria-label="Loading the dashboard">
        <div className="conv-head">
          <h2>Conversations</h2>
          <div className="conv-total"><span className="kpi-value"><SkelText width="3ch" /></span></div>
          <p className="conv-compare"><SkelText width={220} /></p>
        </div>
        <p className="day-readout"><SkelText width={180} /></p>
        <Skeleton className="day-skel" />
        <div className="kpis">
          {kpis.map((label) => (
            <div key={label} className="kpi" aria-hidden="true">
              <div className="kpi-label">{label}</div>
              <div className="kpi-value"><SkelText width="3ch" /></div>
              <div className="kpi-detail"><SkelText width={110} /></div>
            </div>
          ))}
        </div>
      </section>
      <TopTopicsSkeleton />
      <div className="dash-grid" aria-hidden="true">
        {[0, 1].map((i) => (
          <section key={i} className="dash-card">
            <div className="dash-card-head"><h2><SkelText width={140} /></h2></div>
            <Skeleton className="dash-rows-skel" />
          </section>
        ))}
      </div>
    </>
  );
}

export function ReportsPage({ workspaceId, path, canEdit }: { workspaceId: string; path: string; canEdit: boolean }) {
  const [days, setDays] = useState<MetricPeriod>(7);
  // Bumped after a topic change in the sheet, so the report behind it refreshes.
  const [reload, setReload] = useState(0);
  const topicsOpen = /^\/(dashboard|reports)\/topics\/?$/.test(path);
  const [report, setReport] = useState<MetricsReport | null>(() => reportCache.get(`${workspaceId}:7`) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api<{ report: MetricsReport }>(`/workspaces/${workspaceId}/metrics?days=${days}&tz=${encodeURIComponent(timezone)}`).then(
      (r) => {
        // The same days as the copy already on screen: keep that series, so the chart doesn't redraw.
        const shown = reportCache.get(`${workspaceId}:${days}`)?.conversations.series;
        if (shown && JSON.stringify(shown) === JSON.stringify(r.report.conversations.series)) r.report.conversations.series = shown;
        reportCache.set(`${workspaceId}:${days}`, r.report);
        if (current) setReport(r.report);
      },
      (e) => current && setError(describeError(e)),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, days, reload]);

  const r = report?.days === days ? report : reportCache.get(`${workspaceId}:${days}`) ?? null;
  const empty = r && r.conversations.total === 0 && r.csat.good + r.csat.bad === 0;
  const mapped = r && !r.ai.off ? mapTopics(r.topics.list) : [];
  const showMap = mapped.length >= MIN_MAP_TOPICS;
  const mapNote = !r || showMap || r.ai.off || r.topics.list.length === 0
    ? null
    : "The topic map appears here once a topic has AI chats in this period.";

  return (
    <div className="content wide reports">
      <div className="row reports-head">
        <h1>Reports</h1>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Period">
          {METRIC_PERIODS.map((p) => (
            <Button key={p} variant="ghost" size="sm" className={p === days ? "active" : ""} aria-pressed={p === days} onClick={() => setDays(p)}>{p} days</Button>
          ))}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!r ? (
        !error && <DashboardSkeleton aiOff={(report ?? [...reportCache.values()].at(-1))?.ai.off ?? false} />
      ) : empty ? (
        <section className="dash-card">
          <p className="muted">No conversations in the last {days} days. Numbers show up here once visitors start chatting.</p>
        </section>
      ) : (
        <>
          {r.truncated && <p className="muted small">Based on the newest {MAX_METRIC_CONVERSATIONS.toLocaleString()} conversations in this period.</p>}
          <Overview r={r} />
          {showMap && <TopicMapSection topics={r.topics} mapped={mapped} />}
          <TopTopics topics={r.topics} showAi={!r.ai.off} aiEnabled={r.ai.enabled} manage={!showMap} mapNote={mapNote} />

          <div className="dash-grid">
            <StartPages pages={r.pages} />
            {r.struggles && <Struggles struggles={r.struggles} />}
            {!r.ai.off && (
              <section className="dash-card">
                <div className="dash-card-head"><h2>Top handoff reasons</h2></div>
                {r.ai.reasons.length === 0 ? (
                  <p className="muted small">No handoffs in this period.</p>
                ) : (
                  <ul className="dash-rows bars">
                    {r.ai.reasons.map((x) => (
                      <li key={x.reason} style={{ "--share": x.count / r.ai.reasons[0]!.count } as CSSProperties}>
                        <span className="dash-row-label">{x.reason}</span>
                        <span className="dash-row-share">{percent(x.count / r.ai.handedOff)}</span>
                        <span className="dash-row-value">{x.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <Ratings csat={r.csat} />
          </div>

          <section className="dash-card">
            <div className="dash-card-head"><h2>Team</h2></div>
            <Table className="team-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Teammate</TableHead>
                  <TableHead>Replies</TableHead>
                  <TableHead>Conversations</TableHead>
                  <TableHead>First response</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.teammates.map((t) => (
                  <TableRow key={t.userId}>
                    <TableCell className="strong">{t.name}</TableCell>
                    <TableCell data-label="Replies">{t.replies.toLocaleString()}</TableCell>
                    <TableCell data-label="Conversations">{t.conversations.toLocaleString()}</TableCell>
                    <TableCell data-label="First response">{duration(t.firstResponse.median)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="dash-foot">Replies the teammate sent in this period (not notes), the conversations they replied in, and their median first response when they answered first.</p>
          </section>
        </>
      )}
      <Sheet open={topicsOpen} onOpenChange={(o) => { if (!o) navigate("/dashboard", { replace: true }); }}>
        <SheetContent side="right" className="topics-sheet">
          <SheetHeader>
            <SheetTitle>Topics</SheetTitle>
            <SheetDescription>{canEdit ? "Rename, merge or delete the AI's topic labels, or label quiet chats now." : "The AI's topic labels. Only owners and admins can change them."}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="topics-sheet-body">
            {topicsOpen && <TopicsPanel workspaceId={workspaceId} canEdit={canEdit} onChange={() => setReload((n) => n + 1)} />}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
