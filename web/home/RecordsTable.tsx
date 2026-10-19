import { useState } from "react";
import type { StepTable } from "../../shared/desk-assistant.ts";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { ArrowDownIcon, ArrowUpIcon, ChatIcon, ContactsIcon } from "@/components/icons.tsx";
import { nextSort, RECORD_COLUMNS, recordHref, sortRecords, type RecordColumn, type RecordRow, type Sort } from "../lib/records.ts";
import { formatTime } from "../lib/thread.ts";
import { DeskLink } from "./DeskLink.tsx";

// D-134, after beautifului.dev's Records Table (patterns only): the chats or contacts a read step found,
// as a compact table under the turn's steps: names link to the chat or contact, a header click sorts
// (again flips, a third time goes back to the tool's order), and the whole table folds.

const TITLES: Record<StepTable["kind"], [string, string]> = { chats: ["chat", "chats"], people: ["person", "people"], companies: ["company", "companies"] };

function Cell({ column, row, kind }: { column: RecordColumn; row: RecordRow; kind: StepTable["kind"] }) {
  const v = (row as unknown as Record<string, unknown>)[column.key];
  if (column.type === "name") return <DeskLink href={recordHref(kind, row.id)} className="rec-name" title="Open">{String(v)}</DeskLink>;
  if (v === null || v === undefined || v === "") return <span className="rec-empty">—</span>;
  if (column.type === "time") return <span className="rec-num" title={new Date(v as number).toLocaleString()}>{formatTime(v as number)}</span>;
  if (column.type === "number") return <span className="rec-num">{String(v)}</span>;
  if (column.type === "status") return <span className={`rec-status ${String(v)}`}>{String(v)}</span>;
  return <>{String(v)}</>;
}

export function RecordsTable({ table }: { table: StepTable }) {
  const [open, setOpen] = useState(true);
  const [sort, setSort] = useState<Sort>(null);
  const columns = RECORD_COLUMNS[table.kind];
  const rows = sortRecords<RecordRow>(table.rows, sort);
  const [one, many] = TITLES[table.kind];
  const n = table.rows.length;
  const total = table.kind === "chats" && table.total ? ` of ${table.total}` : "";
  return (
    <div className="rec">
      <button type="button" data-plain className="rec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rec-head-icon" aria-hidden="true">{table.kind === "chats" ? <ChatIcon /> : <ContactsIcon />}</span>
        <span>
          <span className="rec-num">{n}{total}</span> {n === 1 && !total ? one : many}
        </span>
        <Chevron open={open} />
      </button>
      <Fold open={open}>
        <div className="rec-wrap">
          <table className="rec-table">
            <thead>
              <tr>
                {columns.map((c) => {
                  const on = sort?.key === c.key ? sort.dir : null;
                  return (
                    <th key={c.key} aria-sort={on === "asc" ? "ascending" : on === "desc" ? "descending" : "none"} className={[c.type === "number" || c.type === "time" ? "end" : "", c.optional ? "opt" : ""].join(" ").trim() || undefined}>
                      <button type="button" data-plain onClick={() => setSort(nextSort(sort, c))}>
                        {c.label}
                        {on && <span className="rec-sort" aria-hidden="true">{on === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.key} className={[c.type === "number" || c.type === "time" ? "end" : c.type === "name" ? "first" : "", c.optional ? "opt" : ""].join(" ").trim() || undefined}>
                      <Cell column={c} row={r} kind={table.kind} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
    </div>
  );
}
