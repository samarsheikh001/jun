import type { StepTable } from "../../shared/desk-assistant.ts";

// D-134: the Records Table's columns and sorting (pure; web/home/RecordsTable.tsx draws it).

export type RecordRow = StepTable["rows"][number];
export interface RecordColumn {
  key: string;
  label: string;
  type: "name" | "text" | "status" | "number" | "time";
  /** Left out when the pane is narrow. */
  optional?: boolean;
}

export const RECORD_COLUMNS: Record<StepTable["kind"], RecordColumn[]> = {
  chats: [
    { key: "name", label: "Customer", type: "name" },
    { key: "status", label: "Status", type: "status" },
    { key: "assignee", label: "Assignee", type: "text" },
    { key: "topic", label: "Topic", type: "text", optional: true },
    { key: "last", label: "Last message", type: "time" },
  ],
  people: [
    { key: "name", label: "Name", type: "name" },
    { key: "email", label: "Email", type: "text", optional: true },
    { key: "company", label: "Company", type: "text" },
    { key: "chats", label: "Chats", type: "number" },
    { key: "last", label: "Last seen", type: "time" },
  ],
  companies: [
    { key: "name", label: "Company", type: "name" },
    { key: "people", label: "People", type: "number" },
    { key: "chats", label: "Chats", type: "number" },
    { key: "last", label: "Last activity", type: "time" },
  ],
};

/** Where a row's name links. */
export function recordHref(kind: StepTable["kind"], id: string): string {
  return kind === "chats" ? `/inbox/${id}` : kind === "people" ? `/contacts/${id}` : `/contacts/companies/${id}`;
}

export type Sort = { key: string; dir: "asc" | "desc" } | null;

/** The rows sorted by one column; empty values last either way. Null keeps the tool's order. */
export function sortRecords<T extends RecordRow>(rows: T[], sort: Sort): T[] {
  if (!sort) return rows;
  const value = (r: T) => (r as unknown as Record<string, unknown>)[sort.key];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const empty = (v: unknown) => v === null || v === undefined || v === "";
    if (empty(x) || empty(y)) return empty(x) === empty(y) ? 0 : empty(x) ? 1 : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base", numeric: true });
    return sort.dir === "asc" ? c : -c;
  });
}

/** A header click: a new column sorts its natural way first (text A→Z, numbers and times high first), the same one flips, a third click resets. */
export function nextSort(sort: Sort, column: RecordColumn): Sort {
  const first: "asc" | "desc" = column.type === "number" || column.type === "time" ? "desc" : "asc";
  if (!sort || sort.key !== column.key) return { key: column.key, dir: first };
  if (sort.dir === first) return { key: column.key, dir: first === "asc" ? "desc" : "asc" };
  return null;
}
