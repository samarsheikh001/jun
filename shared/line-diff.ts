// AI-31: what changed between two versions of an agent file, as a unified diff (the MCP's
// diff_versions). Pure. Lines are compared whole; the common start and end are skipped first, so a
// small edit to a big file stays cheap, and a middle too big to compare is shown replaced whole.

/** Lines of context around each change. */
export const CONTEXT = 3;
/** Above this many line pairs in the changed middle, it's shown removed and added whole. */
const MAX_PAIRS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string };

const linesOf = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** The edit script from `a` to `b`: kept, removed and added lines in order (longest common subsequence). */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const head = a.slice(0, start).map((line): Op => ({ kind: " ", line }));
  const tail = a.slice(endA).map((line): Op => ({ kind: " ", line }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > MAX_PAIRS) {
    return [...head, ...x.map((line): Op => ({ kind: "-", line })), ...y.map((line): Op => ({ kind: "+", line })), ...tail];
  }
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..], in one flat array.
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const middle: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) middle.push({ kind: " ", line: x[i++]! }), j++;
    else if (j < y.length && (i === x.length || lcs[i * w + j + 1]! > lcs[(i + 1) * w + j]!)) middle.push({ kind: "+", line: y[j++]! });
    else middle.push({ kind: "-", line: x[i++]! });
  }
  return [...head, ...middle, ...tail];
}

/**
 * A unified diff of one file, `--- a/<path>` / `+++ b/<path>` and @@ hunks with CONTEXT lines around
 * each change. `before` null: the file is new; `after` null: it was deleted. "" when nothing changed.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return "";
  const ops = editScript(before === null ? [] : linesOf(before), after === null ? [] : linesOf(after));
  const changed = ops.map((op, k) => (op.kind === " " ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return "";
  // Hunks: runs of ops within CONTEXT lines of a change, merged when they touch.
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(ops.length, k + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
  // Line numbers where each op sits in the old and the new file.
  let oldLine = 1;
  let newLine = 1;
  const at = ops.map((op) => {
    const here = { old: oldLine, new: newLine };
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
    return here;
  });
  for (const [from, to] of hunks) {
    const part = ops.slice(from, to);
    const oldCount = part.filter((op) => op.kind !== "+").length;
    const newCount = part.filter((op) => op.kind !== "-").length;
    // Per the unified format, an empty side starts at the line before it (0 for an empty file).
    const oldStart = oldCount ? at[from]!.old : at[from]!.old - 1;
    const newStart = newCount ? at[from]!.new : at[from]!.new - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...part.map((op) => `${op.kind}${op.line}`));
  }
  return out.join("\n");
}
