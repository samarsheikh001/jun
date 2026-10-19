import { useState, type CSSProperties, type MouseEvent } from "react";
import { ArrowRightIcon, BotIcon, BugIcon, ClockIcon, HandoffIcon } from "@/components/icons";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { formatDuration, type HandoffReason, type MetricsReport } from "../../shared/metrics.ts";
import { handoffInsight, handoffNextStep, reasonTopicsLine, type HandoffStep } from "../lib/handoff-reasons.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { ChatsSheet } from "./ChatsSheet.tsx";
import { BarCard, BarStat, Insight, useActiveRow } from "./RankedBars.tsx";

// D-126: Top handoff reasons in Top topics' look (D-125): the written line and stats on the left, a
// ranked bar per grouped reason on the right with its share of handoffs and the topics it comes from.
// A row opens a sheet of its chats; recognisable reasons carry a one-line next step.

const percent = (r: number) => `${Math.round(r * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const goTo = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  navigate(path);
};

/** Reasons shown before "Show all" (the report keeps up to MAX_HANDOFF_REASONS). */
const REASONS_SHOWN = 5;

/** The next step as a small button: a link for Knowledge and AI settings; for a bug, the words (the issue is filed from a chat). */
function NextStep({ step }: { step: HandoffStep }) {
  if (!step.path) {
    return <p className="hr-step-note"><BugIcon aria-hidden="true" />Open a chat below and press Create issue to file it on GitHub or Linear.</p>;
  }
  return (
    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={deskHref(step.path)} onClick={goTo(step.path)}>
      {step.label} <ArrowRightIcon />
    </a>
  );
}

function ReasonCard({ x, box }: { x: HandoffReason; box: HTMLDivElement | null }) {
  const step = handoffNextStep(x.reason);
  return (
    <BarCard box={box} active={x.reason}>
      <span className="tt-card-name">{x.reason}</span>
      <span className="tt-card-row"><span>Handoffs</span><b>{x.count.toLocaleString()} ({percent(x.share)})</b></span>
      {x.replyMedian !== null && <span className="tt-card-row"><span>Team replied in</span><b>{formatDuration(x.replyMedian)}</b></span>}
      {x.topics.length > 0 && <span className="tt-card-foot">{x.topics.map((t) => `${t.name} ${t.count}`).join(" · ")}</span>}
      <span className="tt-card-foot">{step ? `Next step: ${step.label.toLowerCase()}` : "Click for its chats"}</span>
    </BarCard>
  );
}

/**
 * A-01's handoff reasons after D-126. `ai.reasons` are grouped by handoffReasonLabel, most first;
 * shares are of all handoffs in the period. The section is left out while the AI is off.
 */
export function HandoffReasons({ ai }: { ai: MetricsReport["ai"] }) {
  const { active, hover } = useActiveRow();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<HandoffReason | null>(null);
  const reasons = ai.reasons;
  // Never a "Show all" for one more row.
  const rows = all || reasons.length <= REASONS_SHOWN + 1 ? reasons : reasons.slice(0, REASONS_SHOWN);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const insight = handoffInsight(reasons, ai.handedOff);
  const activeRow = rows.find((r) => r.reason === active) ?? null;
  const step = open ? handoffNextStep(open.reason) : null;
  const topicsOf = open ? reasonTopicsLine(open) : null;
  const listed = reasons.reduce((s, x) => s + x.count, 0);
  return (
    <section className="dash-card top-handoffs">
      <div className="dash-card-head"><h2>Top handoff reasons</h2></div>
      {reasons.length === 0 ? (
        <p className="muted small">No handoffs in this period. When the AI passes a chat to the team, its reason shows up here.</p>
      ) : (
        <>
          <div className="tt-layout">
            <div className="tt-side">
              {insight && <Insight parts={insight} />}
              <dl className="tt-stats">
                <BarStat icon={HandoffIcon} value={ai.handedOff.toLocaleString()} label="Handed off" />
                {ai.handoffRate !== null && (
                  <BarStat icon={BotIcon} value={percent(ai.handoffRate)} label="Of AI chats" hint={`${ai.handedOff} of the ${ai.conversations} AI chats went to the team`} />
                )}
                {ai.handoffReply.median !== null && (
                  <BarStat
                    icon={ClockIcon}
                    value={formatDuration(ai.handoffReply.median)}
                    label="Handoff to team reply"
                    hint={`Median from the handoff to the team's first reply, over the ${ai.handoffReply.count} handed-off chats answered after it`}
                  />
                )}
              </dl>
            </div>
            <div className="tt-bars" ref={setBox}>
              <ol className="tt-rows hr-rows">
                {rows.map((x, i) => {
                  const sub = reasonTopicsLine(x);
                  return (
                    <li key={x.reason} data-row={x.reason} style={{ "--w": x.count / max } as CSSProperties}>
                      <button
                        type="button"
                        className={`tt-row${i === 0 ? " lead" : ""}${active === x.reason ? " on" : ""}`}
                        onClick={() => setOpen(x)}
                        aria-label={`${x.reason}: ${plural(x.count, "handoff")}, ${percent(x.share)} of handoffs${sub ? `, ${sub}` : ""}. Show the chats`}
                        {...hover(x.reason)}
                      >
                        <span className="tt-label hr-label" title={x.reason}>
                          <span className="hr-name">{x.reason}</span>
                          {sub && <span className="hr-sub">{sub}</span>}
                        </span>
                        <span className="tt-track">
                          <span className="tt-fill"><span className="tt-share">{percent(x.share)}</span></span>
                          <span className="tt-value">{x.count.toLocaleString()}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {activeRow && <ReasonCard key={activeRow.reason} x={activeRow} box={box} />}
            </div>
          </div>
          {reasons.length > rows.length || all ? (
            <Button variant="ghost" size="sm" className="pg-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${reasons.length}`}
            </Button>
          ) : null}
          <p className="dash-foot">
            Bars are handoffs per reason, similar reasons grouped; the pill is the reason's share of the {plural(ai.handedOff, "handoff")}
            {listed < ai.handedOff ? ` (${ai.handedOff - listed} under reasons not listed)` : ""}. Topics come from the AI's labels. Click a reason for its chats.
          </p>
        </>
      )}
      <ChatsSheet
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.reason ?? ""}
        description={open ? `${plural(open.count, "chat")} handed off${topicsOf ? ` · ${topicsOf}` : ""}` : ""}
        action={step && <NextStep step={step} />}
        total={open?.count ?? 0}
        chats={(open?.chats ?? []).map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          aside: (
            <>
              {c.topic && <span className="hr-chat-topic">{c.topic}</span>}
              <span className={`tt-pill hr-chat-reply${c.replied ? "" : " none"}`}>
                {c.replyAfter !== null ? `Replied in ${formatDuration(c.replyAfter)}` : c.replied ? "Replied" : "No reply yet"}
              </span>
            </>
          ),
        }))}
      />
    </section>
  );
}

/** The section while the report loads: the same columns and rows, the bars as skeletons. */
export function HandoffReasonsSkeleton() {
  return (
    <section className="dash-card top-handoffs" aria-hidden="true">
      <div className="dash-card-head"><h2>Top handoff reasons</h2></div>
      <div className="tt-layout">
        <div className="tt-side">
          <p className="tt-insight"><SkelText width="100%" /><br /><SkelText width="50%" /></p>
          <dl className="tt-stats">
            {["Handed off", "Of AI chats"].map((label) => (
              <div key={label} className="tt-stat"><span className="tt-stat-icon" /><dd><SkelText width="3ch" /></dd><dt>{label}</dt></div>
            ))}
          </dl>
        </div>
        <div className="tt-bars">
          <ol className="tt-rows hr-rows">
            {[1, 0.7, 0.5, 0.35].map((w, i) => (
              <li key={i} style={{ "--w": w } as CSSProperties}>
                <div className="tt-row">
                  <span className="tt-label hr-label"><span className="hr-name"><SkelText width={120} /></span><span className="hr-sub"><SkelText width={80} /></span></span>
                  <span className="tt-track"><span className="tt-fill skel" /></span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
