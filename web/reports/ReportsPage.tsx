import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ArrowDownIcon as ArrowDown, ArrowRightIcon as ArrowRight, ArrowUpIcon as ArrowUp, ThumbsDownIcon, ThumbsUpIcon } from "@/components/icons";
import { formatDuration, MAX_METRIC_CONVERSATIONS, METRIC_PERIODS, type DayPoint, type MetricPeriod, type MetricsReport } from "../../shared/metrics.ts";
import { api, describeError } from "../api.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import DayChart from "./DayChart.tsx";

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

/** A-06: where visitors were when they opened a chat. Paths only when every page is on one site. */
function StartPages({ pages }: { pages: MetricsReport["pages"] }) {
  const origins = new Set(pages.top.map((p) => new URL(p.page).origin));
  const site = origins.size === 1 ? new URL(pages.top[0]!.page).host : null;
  const label = (page: string) => {
    const u = new URL(page);
    let path = u.pathname;
    try {
      path = decodeURI(path);
    } catch {
      // Not valid percent-encoding: show it as stored.
    }
    // Long paths wrap after a slash; with several sites the host stays on one line.
    const parts = (site || path !== "/" ? path : "").split(/(?<=\/)/);
    return (
      <>
        {!site && <span className="page-host">{u.host}</span>}
        {parts.map((part, i) => (
          <span key={i}>
            {part}
            <wbr />
          </span>
        ))}
      </>
    );
  };
  const rest = pages.withPage - pages.top.reduce((s, p) => s + p.count, 0);
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Pages where chats start</h2>
        {site && <span className="muted small nums">{site}</span>}
      </div>
      {pages.top.length === 0 ? (
        <p className="muted small">
          No chats from your site in this period. The widget notes the page a visitor is on when they send their first message.
        </p>
      ) : (
        <>
          <ul className="dash-rows bars">
            {pages.top.map((p) => (
              <li key={p.page} title={p.page} style={{ "--share": p.count / pages.top[0]!.count } as CSSProperties}>
                <span className="dash-row-label page-path">{label(p.page)}</span>
                <span className="dash-row-share">{percent(p.share)}</span>
                <span className="dash-row-value">{p.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="dash-foot">
            Share of the {pages.withPage.toLocaleString()} chats that started on a known page{rest > 0 ? ` (${rest} on pages not listed)` : ""}.
            {pages.withoutPage > 0 && ` ${pages.withoutPage} had no page (opened outside your site).`} Numbers and ids in paths are grouped as :id.
          </p>
        </>
      )}
    </section>
  );
}

const STRUGGLE_WORDS = { rage_click: "Rage clicks", dead_click: "Clicks that did nothing", stuck: "Stuck after a problem" } as const;

/** A-08: where visitors who chatted got frustrated (rage clicks, dead clicks, stuck), by page and element. */
function Struggles({ struggles }: { struggles: MetricsReport["struggles"] }) {
  const path = (page: string) => {
    try {
      return decodeURI(new URL(page).pathname);
    } catch {
      return page;
    }
  };
  return (
    <section className="dash-card">
      <div className="dash-card-head"><h2>Where visitors struggle</h2></div>
      {struggles.list.length === 0 ? (
        <p className="muted small">No rage clicks, dead clicks or stuck pages in this period's chats. The widget records them on your site and shares them when a visitor writes in.</p>
      ) : (
        <>
          <ul className="dash-rows bars">
            {struggles.list.map((s) => (
              <li key={`${s.kind}|${s.page}|${s.target}`} title={s.page} style={{ "--share": s.conversations / struggles.list[0]!.conversations } as CSSProperties}>
                <span className="dash-row-label">
                  {STRUGGLE_WORDS[s.kind]}
                  {s.target && <> on <code>{s.target}</code></>}
                  <div className="muted small struggle-page">{path(s.page)}</div>
                </span>
                <span className="dash-row-value">{s.conversations.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="dash-foot">
            Chats whose visitor hit this before or while writing in ({struggles.conversations.toLocaleString()} chats had at least one). Only visitors who chatted are counted: the widget sends what happened with their messages.
          </p>
        </>
      )}
    </section>
  );
}

/** Most topics "Top topics" lists. */
const MAX_TOPICS_SHOWN = 8;

/** A-02: what visitors ask about, from the AI's topic labels. A topic opens the inbox filtered by it. */
function TopTopics({ topics, showAi, aiEnabled }: { topics: MetricsReport["topics"]; showAi: boolean; aiEnabled: boolean }) {
  const top = topics.list.slice(0, MAX_TOPICS_SHOWN);
  const rest = topics.list.length - top.length;
  // The AI's rate per topic is a column only when it differs between topics; one rate for all is a line.
  const rates = new Set(top.flatMap((t) => (t.aiResolutionRate === null ? [] : [percent(t.aiResolutionRate)])));
  const rateColumn = showAi && rates.size > 1;
  const oneRate = showAi && rates.size === 1 ? [...rates][0] : null;
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Top topics</h2>
        <a className="small" href={deskHref("/settings/inbox#topics")} onClick={goTo("/settings/inbox#topics")}>Manage</a>
      </div>
      {top.length === 0 ? (
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
          <ul className="dash-rows links bars">
            {top.map((t) => (
              <li key={t.id} style={{ "--share": t.share / top[0]!.share } as CSSProperties}>
                <a href={deskHref(`/inbox?topic=${t.id}`)} onClick={goTo(`/inbox?topic=${encodeURIComponent(t.id)}`)} title={`Open the ${t.name} conversations in the inbox`}>
                  <span className="dash-row-label">{t.name}</span>
                  {rateColumn && (
                    <span className="dash-row-share" title="Resolved by the AI alone, of this topic's AI chats">{t.aiResolutionRate === null ? "" : `AI ${percent(t.aiResolutionRate)}`}</span>
                  )}
                  <span className="dash-row-share">{percent(t.share)}</span>
                  <span className="dash-row-value">{t.count.toLocaleString()}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="dash-foot">
            Share of the {topics.labeled.toLocaleString()} labelled chats{rest > 0 ? ` (${rest} more topic${rest === 1 ? "" : "s"} not listed)` : ""}.
            {rateColumn && " AI % is how many of the topic's AI chats the AI resolved alone."}
            {oneRate && ` The AI resolved ${oneRate} of each topic's AI chats alone.`}
            {!aiEnabled && " New chats aren't labelled while AI replies are off."}
            {aiEnabled && topics.unlabeled > 0 && ` ${topics.unlabeled} chat${topics.unlabeled === 1 ? " isn't" : "s aren't"} labelled yet (still going, or quiet for less than a few minutes).`}
          </p>
        </>
      )}
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

export function ReportsPage({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<MetricPeriod>(7);
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
  }, [workspaceId, days]);

  const r = report?.days === days ? report : reportCache.get(`${workspaceId}:${days}`) ?? null;
  const empty = r && r.conversations.total === 0 && r.csat.good + r.csat.bad === 0;

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

          <div className="dash-grid">
            <TopTopics topics={r.topics} showAi={!r.ai.off} aiEnabled={r.ai.enabled} />
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
    </div>
  );
}
