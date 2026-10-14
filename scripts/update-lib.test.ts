import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFile, isWorkflowFile, keepResourceNames, pullRequestBody, type MergeText } from "./update-lib.ts";

const b = (s: string) => new TextEncoder().encode(s);
const text = (d: { action: string; content?: Uint8Array }) => (d.content ? new TextDecoder().decode(d.content) : null);
// A stand-in for git merge-file: clean when only one side changed a line of a two-line file.
const merge: MergeText = (ours, base, theirs) => {
  const [o, bs, t] = [ours, base, theirs].map((s) => s.split("\n"));
  const out = bs!.map((line, i) => (o![i] !== line ? o![i]! : t![i]!));
  const conflict = bs!.some((line, i) => o![i] !== line && t![i] !== line && o![i] !== t![i]);
  return { text: conflict ? "<<<<<<< conflict" : out.join("\n"), conflict };
};

test("an untouched file takes the release's version", () => {
  const d = decideFile("web/a.ts", b("old"), b("old"), b("new"), merge);
  assert.equal(d.action, "write");
  assert.equal(text(d), "new");
});

test("the owner's edit stays when Jun didn't change the file", () => {
  assert.deepEqual(decideFile("web/a.ts", b("old"), b("mine"), b("old"), merge), { action: "keep" });
});

test("both changed different lines: merged", () => {
  const d = decideFile("web/a.ts", b("a\nb"), b("A\nb"), b("a\nB"), merge);
  assert.equal(text(d), "A\nB");
  assert.ok(d.action === "write" && !d.conflict);
});

test("both changed the same line: a conflict to resolve", () => {
  const d = decideFile("web/a.ts", b("a"), b("mine"), b("theirs"), merge);
  assert.ok(d.action === "write" && d.conflict);
});

test("new, removed and own files", () => {
  assert.equal(decideFile("web/new.ts", null, null, b("x"), merge).action, "write");
  assert.equal(decideFile("web/gone.ts", b("x"), b("x"), null, merge).action, "delete");
  assert.equal(decideFile("web/gone.ts", b("x"), b("edited"), null, merge).action, "keep");
  assert.deepEqual(decideFile("notes/mine.md", null, b("x"), null, merge), { action: "keep" });
  assert.equal(decideFile("web/a.ts", b("x"), null, b("y"), merge).action, "keep");
});

test("binary files are never merged", () => {
  const d = decideFile("public/a.png", b("a\0"), b("b\0"), b("c\0"), merge);
  assert.equal(d.action, "keep");
});

test("no known base: the release's file wins", () => {
  assert.equal(text(decideFile("web/a.ts", null, b("old"), b("new"), merge)), "new");
});

const RELEASE = `{
  // comment
  "name": "jun-desk",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "jun-desk",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "jun-desk-files" }],
  "queues": {
    "producers": [{ "binding": "CRAWL_QUEUE", "queue": "jun-desk-crawl" }],
    "consumers": [{ "queue": "jun-desk-crawl", "max_batch_size": 4 }]
  },
  "new_setting": true,
  "durable_objects": { "bindings": [{ "name": "CONVERSATION", "class_name": "Conversation" }] }
}`;

// What the Deploy button writes into a copy (from a real one).
const COPY = `{
  "name": "jun-check",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "jun-check",
      "migrations_dir": "migrations","database_id": "12bd20c9-8d09-4643-8def-86439e9251ac"
    }
  ],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "jun-check-files","preview_bucket_name": "jun-check-files" }],
  "queues": {
    "producers": [{ "binding": "CRAWL_QUEUE", "queue": "jun-check-crawl" }],
    "consumers": [{ "queue": "jun-check-crawl", "max_batch_size": 4, "max_batch_timeout": 2 }]
  }
}`;

test("wrangler.jsonc keeps the copy's resource names and takes everything else", () => {
  const out = keepResourceNames(RELEASE, COPY);
  const parsed = JSON.parse(out.replace(/\/\/[^\n]*/g, ""));
  assert.equal(parsed.name, "jun-check");
  assert.equal(parsed.d1_databases[0].database_name, "jun-check");
  assert.equal(parsed.d1_databases[0].database_id, "12bd20c9-8d09-4643-8def-86439e9251ac");
  assert.equal(parsed.r2_buckets[0].bucket_name, "jun-check-files");
  assert.equal(parsed.r2_buckets[0].preview_bucket_name, "jun-check-files");
  assert.equal(parsed.queues.producers[0].queue, "jun-check-crawl");
  assert.equal(parsed.queues.consumers[0].queue, "jun-check-crawl");
  assert.equal(parsed.new_setting, true);
  assert.equal(parsed.durable_objects.bindings[0].name, "CONVERSATION");
  assert.match(out, /\/\/ comment/);
});

test("wrangler.jsonc without a base: names kept, never a plain overwrite", () => {
  const d = decideFile("wrangler.jsonc", null, b(COPY), b(RELEASE), merge);
  assert.equal(d.action, "write");
  assert.match(text(d)!, /"name": "jun-check"/);
});

test("workflow files are left to the owner", () => {
  assert.ok(isWorkflowFile(".github/workflows/update-jun.yml"));
  assert.ok(!isWorkflowFile(".github/ISSUE_TEMPLATE.md"));
});

test("the pull request says what to do", () => {
  const body = pullRequestBody({ from: "0.1.0", to: "v0.2.0", upstream: "samarsheikh001/jun", notes: "- Faster inbox", conflicts: ["web/a.ts"], remarks: [], workflows: [".github/workflows/release.yml"] });
  assert.match(body, /from v0\.1\.0 to \*\*v0\.2\.0\*\*/);
  assert.match(body, /Resolve before merging/);
  assert.match(body, /web\/a\.ts/);
  assert.match(body, /Faster inbox/);
});
