import { useState } from "react";
import { bulkField, bulkVerb, outcomeTitle, type BulkResult, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import { ApprovalCard, ApprovalOutcome } from "@/components/approval-card.tsx";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { CheckIcon, ChatIcon, RefreshIcon, XIcon } from "@/components/icons.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import type { BulkRowState } from "./actions.ts";
import { DeskLink } from "./DeskLink.tsx";

// D-134, after beautifului.dev's Diff Table and Task Rows (patterns, our own code and tokens): one change
// on several chats. Waiting, the card is a table, a row per chat (the customer linking to the chat, the
// field before → after, the new value highlighted), each with a checkbox to leave it out, and one Confirm
// naming the count. Running and after, Task Rows: queued / running / done / failed (its error, Retry).

type Bulk = Extract<ProposedAction["proposal"], { kind: "bulk" }>;

function DiffTable({ p, chosen, onToggle, disabled }: { p: Bulk; chosen: Set<string>; onToggle: (id: string | null, on: boolean) => void; disabled: boolean }) {
  const all = p.items.every((i) => chosen.has(i.conversationId));
  const some = !all && p.items.some((i) => chosen.has(i.conversationId));
  return (
    <div className="bulk-table-wrap">
      <table className="bulk-table">
        <thead>
          <tr>
            <th className="bulk-check">
              <Checkbox checked={all} indeterminate={some} disabled={disabled} aria-label={all ? "Leave every chat out" : "Include every chat"} onCheckedChange={(on) => onToggle(null, on)} />
            </th>
            <th>Chat</th>
            <th>{bulkField(p.op)}</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((item, i) => {
            const on = chosen.has(item.conversationId);
            return (
              <tr key={item.conversationId} className={on ? undefined : "out"} style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}>
                <td className="bulk-check">
                  <Checkbox checked={on} disabled={disabled} aria-label={`${on ? "Leave out" : "Include"} ${item.customer}`} onCheckedChange={(v) => onToggle(item.conversationId, v)} />
                </td>
                <td className="bulk-who">
                  <DeskLink href={`/inbox/${item.conversationId}`} title="Open this chat">
                    {item.customer}
                  </DeskLink>
                </td>
                <td className="bulk-change">
                  <span className="was">{item.before}</span>
                  <span className="bulk-arrow" aria-label="becomes"> → </span>
                  <mark className="now">{item.after}</mark>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowMark({ state }: { state: BulkRowState["status"] | "skipped" }) {
  if (state === "running") return <span className="step-spin" role="img" aria-label="Running" />;
  if (state === "done") return <span className="task-mark done" role="img" aria-label="Done"><CheckIcon size={10} strokeWidth={3} /></span>;
  if (state === "failed") return <span className="task-mark failed" role="img" aria-label="Failed"><XIcon size={10} strokeWidth={3} /></span>;
  return <span className={`task-mark ${state}`} role="img" aria-label={state === "skipped" ? "Left out" : "Queued"} />;
}

/** The live list: one row per chat with its state. */
function TaskRows({ p, rows, onRetry, retrying }: { p: Bulk; rows: Record<string, BulkRowState | { status: "skipped" }>; onRetry?: (id: string) => void; retrying?: string | null }) {
  const listed = p.items.filter((i) => rows[i.conversationId]);
  const done = listed.filter((i) => rows[i.conversationId]!.status === "done").length;
  const ran = listed.filter((i) => rows[i.conversationId]!.status !== "skipped");
  return (
    <div className="task-rows">
      <div className="task-head">
        <span>{p.op === "tags" ? "Tags" : `${bulkField(p.op)} → ${p.items[0]?.after ?? ""}`}</span>
        <span className="task-count">
          {done}/{ran.length}
        </span>
      </div>
      <div className="task-bar" aria-hidden="true">
        <span style={{ width: `${ran.length ? (done / ran.length) * 100 : 0}%` }} />
      </div>
      <ul>
        {listed.map((item) => {
          const r = retrying === item.conversationId ? { status: "running" as const } : rows[item.conversationId]!;
          return (
            <li key={item.conversationId} className={`task-row ${r.status}`}>
              <RowMark state={r.status} />
              <DeskLink href={`/inbox/${item.conversationId}`} className="task-name" title="Open this chat">
                {item.customer}
              </DeskLink>
              <span className="task-state">{r.status === "skipped" ? "left out" : r.status === "queued" ? "queued" : r.status === "running" ? "working…" : r.status === "done" ? item.after : ""}</span>
              {r.status === "failed" && (
                <>
                  <span className="task-error" title={"error" in r ? r.error : undefined}>{"error" in r ? r.error : "failed"}</span>
                  {onRetry && (
                    <button type="button" data-plain className="task-retry" disabled={Boolean(retrying)} onClick={() => onRetry(item.conversationId)}>
                      <RefreshIcon /> Retry
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const resultRows = (results: BulkResult[]) => Object.fromEntries(results.map((r) => [r.conversationId, r.status === "failed" ? { status: "failed" as const, error: r.error } : { status: r.status }]));

export function BulkCard({
  action,
  outcome,
  running,
  rows,
  blocked,
  latest,
  onConfirm,
  onCancel,
  onRetry,
}: {
  action: ProposedAction;
  outcome?: ProposalOutcome;
  running: boolean;
  rows: Record<string, BulkRowState> | null;
  blocked: boolean;
  latest: boolean;
  onConfirm: (chosen: string[]) => void;
  onCancel: () => void;
  onRetry: (id: string) => Promise<void>;
}) {
  const p = action.proposal as Bulk;
  const [chosen, setChosen] = useState(() => new Set(p.items.map((i) => i.conversationId)));
  const [retrying, setRetrying] = useState<string | null>(null);
  const failures = outcome?.results?.some((r) => r.status === "failed") ?? false;
  const [open, setOpen] = useState<boolean | null>(null);
  if (outcome) {
    const shown = open ?? failures;
    return (
      <div className="bulk-settled">
        <ApprovalOutcome status={outcome.status}>{outcomeTitle(p, action.labels, outcome)}</ApprovalOutcome>
        {outcome.results && outcome.results.some((r) => r.status !== "skipped") && (
          <>
            <button type="button" data-plain className="bulk-toggle" aria-expanded={shown} onClick={() => setOpen(!shown)}>
              {p.items.length} chats <Chevron open={shown} />
            </button>
            <Fold open={shown}>
              <TaskRows
                p={p}
                rows={resultRows(outcome.results)}
                retrying={retrying}
                onRetry={(id) => {
                  setRetrying(id);
                  void onRetry(id).finally(() => setRetrying(null));
                }}
              />
            </Fold>
          </>
        )}
      </div>
    );
  }
  const n = chosen.size;
  return (
    <ApprovalCard
      icon={<ChatIcon />}
      title={running ? bulkVerb(p, n, action.labels.assignee).replace(/^(\w+)/, (w) => `${w.replace(/e$/, "")}ing`) : `Change ${p.items.length} chats?`}
      confirmLabel={bulkVerb(p, n, action.labels.assignee)}
      running={running}
      disabled={blocked}
      confirmDisabled={n === 0}
      autoFocus={latest}
      onConfirm={() => onConfirm(p.items.map((i) => i.conversationId).filter((id) => chosen.has(id)))}
      onCancel={onCancel}
    >
      <p className="approval-summary">{action.summary}</p>
      {running && rows ? (
        <TaskRows p={p} rows={rows} />
      ) : (
        <DiffTable
          p={p}
          chosen={chosen}
          disabled={running || blocked}
          onToggle={(id, on) =>
            setChosen((prev) => {
              const next = new Set(id === null ? (on ? p.items.map((i) => i.conversationId) : []) : prev);
              if (id !== null) on ? next.add(id) : next.delete(id);
              return next;
            })
          }
        />
      )}
    </ApprovalCard>
  );
}
