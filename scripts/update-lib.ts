// T-17: the pure half of scripts/update-jun.ts (no git, no network), unit-tested in update-lib.test.ts.
//
// A Deploy-to-Cloudflare copy has no history in common with the Jun repo (one "source repo import"
// commit), so `git merge` can't update it. Instead each file is merged three ways: the Jun release
// the copy came from (base), the copy (ours) and the new release (theirs). Files the owner never
// touched take the new version, their own edits stay, and real clashes are marked for the PR.

export type FileDecision =
  | { action: "keep"; note?: string }
  | { action: "write"; content: Uint8Array; conflict?: boolean; note?: string }
  | { action: "delete" };

/** A text three-way merge (git merge-file): the merged text and whether it has conflict markers. */
export type MergeText = (ours: string, base: string, theirs: string) => { text: string; conflict: boolean };

const enc = new TextEncoder();
const dec = new TextDecoder();
const same = (a: Uint8Array | null, b: Uint8Array | null) => a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
const binary = (b: Uint8Array | null) => b !== null && b.includes(0);

/** Paths an update never writes: GitHub refuses workflow changes from a workflow's own token. */
export const isWorkflowFile = (path: string) => path.startsWith(".github/workflows/");

/**
 * What to do with one file. `base` is null when the copy's release is unknown (copies from before
 * versions) or the file is new; then the release's file wins, except wrangler.jsonc.
 */
export function decideFile(path: string, base: Uint8Array | null, ours: Uint8Array | null, theirs: Uint8Array | null, merge: MergeText): FileDecision {
  if (ours === null && theirs === null) return { action: "keep" };
  if (same(ours, theirs)) return { action: "keep" };
  if (theirs === null) {
    if (base === null) return { action: "keep" }; // the owner's own file
    if (same(ours, base)) return { action: "delete" };
    return { action: "keep", note: "removed from Jun, but changed in your copy: kept" };
  }
  if (ours === null) {
    if (base !== null && same(theirs, base)) return { action: "keep" }; // deleted here, unchanged upstream
    if (base !== null) return { action: "keep", note: "changed in Jun, but deleted in your copy: left deleted" };
    return { action: "write", content: theirs };
  }
  if (path === "wrangler.jsonc") return wranglerDecision(base, ours, theirs, merge);
  if (base === null) return { action: "write", content: theirs };
  if (same(ours, base)) return { action: "write", content: theirs };
  if (same(theirs, base)) return { action: "keep" };
  if (binary(base) || binary(ours) || binary(theirs)) return { action: "keep", note: "changed in Jun and in your copy (a binary file): kept yours" };
  const merged = merge(dec.decode(ours), dec.decode(base), dec.decode(theirs));
  return { action: "write", content: enc.encode(merged.text), conflict: merged.conflict };
}

/** wrangler.jsonc: a normal merge when it's clean, else the new file with the copy's resource names. */
function wranglerDecision(base: Uint8Array | null, ours: Uint8Array, theirs: Uint8Array, merge: MergeText): FileDecision {
  if (base !== null) {
    if (same(theirs, base)) return { action: "keep" };
    const merged = merge(dec.decode(ours), dec.decode(base), dec.decode(theirs));
    if (!merged.conflict) return { action: "write", content: enc.encode(merged.text) };
  }
  return {
    action: "write",
    content: enc.encode(keepResourceNames(dec.decode(theirs), dec.decode(ours))),
    note: "took the new wrangler.jsonc and put your Worker, database, bucket and queue names back; re-add anything else you had added there (routes, vars)",
  };
}

// wrangler.jsonc allows comments; strip them (outside strings) before parsing (as scripts/deploy.ts).
const parseJsonc = (text: string) => JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? "")) as WranglerConfig;

interface WranglerConfig {
  name?: string;
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string; preview_bucket_name?: string }[];
  queues?: { producers?: { binding: string; queue: string }[] };
}

const quote = (s: string) => JSON.stringify(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The new release's wrangler.jsonc with the copy's own resource names: the Worker name, the D1
 * database (name and id), the R2 bucket and the queues. Without them the Worker would bind to
 * other (possibly another desk's) resources. Comments and everything else come from the release.
 */
export function keepResourceNames(theirsText: string, oursText: string): string {
  let ours: WranglerConfig;
  let theirs: WranglerConfig;
  try {
    ours = parseJsonc(oursText);
    theirs = parseJsonc(theirsText);
  } catch {
    return oursText; // unreadable: leave the copy's file as it is
  }
  let text = theirsText;
  if (ours.name && theirs.name) text = text.replace(new RegExp(`("name"\\s*:\\s*)${escape(quote(theirs.name))}`), `$1${quote(ours.name)}`);

  const db = ours.d1_databases?.find((d) => d.binding === "DB");
  const newDb = theirs.d1_databases?.find((d) => d.binding === "DB");
  if (db?.database_name && newDb?.database_name) {
    text = text.replace(new RegExp(`("database_name"\\s*:\\s*)${escape(quote(newDb.database_name))}`), `$1${quote(db.database_name)}`);
    if (db.database_id) {
      text = newDb.database_id
        ? text.replace(new RegExp(`("database_id"\\s*:\\s*)${escape(quote(newDb.database_id))}`), `$1${quote(db.database_id)}`)
        : text.replace(new RegExp(`("database_name"\\s*:\\s*${escape(quote(db.database_name))})`), `$1, "database_id": ${quote(db.database_id)}`);
    }
  }

  const bucket = ours.r2_buckets?.find((b) => b.binding === "FILES");
  const newBucket = theirs.r2_buckets?.find((b) => b.binding === "FILES");
  if (bucket?.bucket_name && newBucket?.bucket_name) {
    text = text.replace(new RegExp(`("bucket_name"\\s*:\\s*)${escape(quote(newBucket.bucket_name))}`), `$1${quote(bucket.bucket_name)}`);
    if (bucket.preview_bucket_name && !newBucket.preview_bucket_name) {
      text = text.replace(new RegExp(`("bucket_name"\\s*:\\s*${escape(quote(bucket.bucket_name))})`), `$1, "preview_bucket_name": ${quote(bucket.preview_bucket_name)}`);
    }
  }

  // A queue is named in its producer and its consumer: rename every mention.
  for (const producer of theirs.queues?.producers ?? []) {
    const mine = ours.queues?.producers?.find((p) => p.binding === producer.binding)?.queue;
    if (mine && mine !== producer.queue) text = text.replace(new RegExp(`("queue"\\s*:\\s*)${escape(quote(producer.queue))}`, "g"), `$1${quote(mine)}`);
  }
  return text;
}

/** The Markdown body of the update pull request. */
export function pullRequestBody(input: {
  from: string | null;
  to: string;
  upstream: string;
  notes: string;
  conflicts: string[];
  remarks: [string, string][];
  workflows: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Updates Jun ${input.from ? `from v${input.from} ` : ""}to **${input.to}** ([release notes](https://github.com/${input.upstream}/releases/tag/${input.to})).`);
  lines.push("", "Merging deploys it: the deploy applies database migrations first, then the new Worker. Conversations, knowledge, passkeys and settings carry over.");
  if (!input.from) lines.push("", "Your copy didn't say which Jun version it came from, so every file now matches the release (your resource names in `wrangler.jsonc` are kept). If you changed Jun's code in this repo, check those files below.");
  if (input.conflicts.length) {
    lines.push("", "### Resolve before merging", "Jun and your copy both changed these files in the same place. They contain `<<<<<<<` markers: edit them on this branch, then merge.");
    for (const path of input.conflicts) lines.push(`- \`${path}\``);
  }
  if (input.remarks.length) {
    lines.push("", "### Notes");
    for (const [path, note] of input.remarks) lines.push(`- \`${path}\`: ${note}`);
  }
  if (input.workflows.length) {
    lines.push("", "### Workflow files to update by hand", "GitHub doesn't let a workflow change workflow files. Copy these from the release:");
    for (const path of input.workflows) lines.push(`- [\`${path}\`](https://github.com/${input.upstream}/blob/${input.to}/${path})`);
  }
  if (input.notes.trim()) lines.push("", "### What's new", "", input.notes.trim());
  lines.push("", "<sub>Opened by the Update Jun workflow (`.github/workflows/update-jun.yml`), which checks for a new release every day. Merge when you're ready; a newer release updates this pull request.</sub>");
  return lines.join("\n");
}
