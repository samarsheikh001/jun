import { useState } from "react";
import { bulkField, bulkRows, bulkVerb, deleteNoun, deleteVerb, outcomeTitle, proposalRisk, type BulkProposal, type BulkResult, type BulkRow, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import { ApprovalCard, ApprovalOutcome } from "@/components/approval-card.tsx";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { CheckIcon, ChatIcon, RefreshIcon, TrashIcon, XIcon } from "@/components/icons.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import type { BulkRowState } from "./actions.ts";
import { DeskLink } from "./DeskLink.tsx";

// D-134, after beautifului.dev's Diff Table and Task Rows (patterns, our own code and tokens): one change
// on several chats. Waiting, the card is a table, a row per chat (the customer linking to the chat, the
// field before → after, the new value highlighted), each with a checkbox to leave it out, and one Confirm
// naming the count. Running and after, Task Rows: queued / running / done / failed (its error, Retry).
// D-144: the same card deletes several saved replies, tags, topics or knowledge pages / sources: a row
// per thing with what goes, in D-133's destructive look (red, "can't be undone", Cancel focused, no Enter).

const Name = ({ row, className }: { row: BulkRow; className?: string }) =>
  row.href ? (
    <DeskLink href={row.href} className={className} title="Open">
      {row.name}
    </DeskLink>
  ) : (
    <span className={className}>{row.name}</span>
  );

function DiffTable({ p, rows, chosen, onToggle, disabled }: { p: BulkProposal; rows: BulkRow[]; chosen: Set<string>; onToggle: (id: string | null, on: boolean) => void; disabled: boolean }) {
  const all = rows.every((i) => chosen.has(i.id));
  const some = !all && rows.some((i) => chosen.has(i.id));
  const del = p.kind === "bulk_delete";
  const noun = del ? deleteNoun(p.target, 2) : "chats";
  return (
    <div className="bulk-table-wrap">
      <table className="bulk-table">
        <thead>
          <tr>
            <th className="bulk-check">
              <Checkbox checked={all} indeterminate={some} disabled={disabled} aria-label={all ? `Leave every one out` : `Include all ${noun}`} onCheckedChange={(on) => onToggle(null, on)} />
            </th>
            <th>{del ? noun.charAt(0).toUpperCase() + deleteNoun(p.target, 1).slice(1) : "Chat"}</th>
            <th>{del ? "What goes" : bulkField(p.op)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => {
            const on = chosen.has(item.id);
            return (
              <tr key={item.id} className={on ? (del ? "goes" : undefined) : "out"} style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}>
                <td className="bulk-check">
                  <Checkbox checked={on} disabled={disabled} aria-label={`${on ? "Leave out" : "Include"} ${item.name}`} onCheckedChange={(v) => onToggle(item.id, v)} />
                </td>
                <td className="bulk-who">
                  <Name row={item} />
                </td>
                {del ? (
                  <td className="bulk-change bulk-gone">{item.before}</td>
                ) : (
                  <td className="bulk-change">
                    <span className="was">{item.before}</span>
                    <span className="bulk-arrow" aria-label="becomes"> → </span>
                    <mark className="now">{item.after}</mark>
                  </td>
                )}
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
function TaskRows({ p, items, rows, onRetry, retrying }: { p: BulkProposal; items: BulkRow[]; rows: Record<string, BulkRowState | { status: "skipped" }>; onRetry?: (id: string) => void; retrying?: string | null }) {
  const listed = items.filter((i) => rows[i.id]);
  const done = listed.filter((i) => rows[i.id]!.status === "done").length;
  const ran = listed.filter((i) => rows[i.id]!.status !== "skipped");
  const head = p.kind === "bulk_delete" ? `${p.target.startsWith("knowledge_") ? "Removing" : "Deleting"} ${deleteNoun(p.target, 2)}` : p.op === "tags" ? "Tags" : `${bulkField(p.op)} → ${items[0]?.after ?? ""}`;
  return (
    <div className="task-rows">
      <div className="task-head">
        <span>{head}</span>
        <span className="task-count">
          {done}/{ran.length}
        </span>
      </div>
      <div className="task-bar" aria-hidden="true">
        <span style={{ width: `${ran.length ? (done / ran.length) * 100 : 0}%` }} />
      </div>
      <ul>
        {listed.map((item) => {
          const r = retrying === item.id ? { status: "running" as const } : rows[item.id]!;
          return (
            <li key={item.id} className={`task-row ${r.status}`}>
              <RowMark state={r.status} />
              <Name row={item} className="task-name" />
              <span className="task-state">{r.status === "skipped" ? "left out" : r.status === "queued" ? "queued" : r.status === "running" ? "working…" : r.status === "done" ? item.after : ""}</span>
              {r.status === "failed" && (
                <>
                  <span className="task-error" title={"error" in r ? r.error : undefined}>{"error" in r ? r.error : "failed"}</span>
                  {onRetry && (
                    <button type="button" data-plain className="task-retry" disabled={Boolean(retrying)} onClick={() => onRetry(item.id)}>
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

const resultRows = (results: BulkResult[]) => Object.fromEntries(results.map((r) => [r.id, r.status === "failed" ? { status: "failed" as const, error: r.error } : { status: r.status }]));

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
  const p = action.proposal as BulkProposal;
  const items = bulkRows(p);
  const [chosen, setChosen] = useState(() => new Set(items.map((i) => i.id)));
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
              {items.length} {p.kind === "bulk_delete" ? deleteNoun(p.target, items.length) : "chats"} <Chevron open={shown} />
            </button>
            <Fold open={shown}>
              <TaskRows
                p={p}
                items={items}
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
  const verb = p.kind === "bulk_delete" ? deleteVerb(p, n) : bulkVerb(p, n, action.labels.assignee);
  const risk = proposalRisk(p);
  return (
    <ApprovalCard
      icon={p.kind === "bulk_delete" ? <TrashIcon /> : <ChatIcon />}
      title={running ? verb.replace(/^(\w+)/, (w) => `${w.replace(/e$/, "")}ing`) : p.kind === "bulk_delete" ? `${deleteVerb(p, items.length)}?` : `Change ${items.length} chats?`}
      confirmLabel={verb}
      running={running}
      disabled={blocked}
      confirmDisabled={n === 0}
      autoFocus={latest}
      tone={risk?.tone}
      warning={risk?.line}
      onConfirm={() => onConfirm(items.map((i) => i.id).filter((id) => chosen.has(id)))}
      onCancel={onCancel}
    >
      <p className="approval-summary">{action.summary}</p>
      {running && rows ? (
        <TaskRows p={p} items={items} rows={rows} />
      ) : (
        <DiffTable
          p={p}
          rows={items}
          chosen={chosen}
          disabled={running || blocked}
          onToggle={(id, on) =>
            setChosen((prev) => {
              const next = new Set(id === null ? (on ? items.map((i) => i.id) : []) : prev);
              if (id !== null) on ? next.add(id) : next.delete(id);
              return next;
            })
          }
        />
      )}
    </ApprovalCard>
  );
}
