import assert from "node:assert/strict";
import { test } from "node:test";
import { unifiedDiff } from "./line-diff.ts";

test("line diff: one changed line, with three lines of context", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const after = "a\nb\nc\nd\nE\nf\ng\nh\n";
  assert.equal(unifiedDiff("x.md", before, after), ["--- a/x.md", "+++ b/x.md", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"].join("\n"));
});

test("line diff: nothing changed, a new file, a deleted file", () => {
  assert.equal(unifiedDiff("x.md", "same\n", "same\n"), "");
  assert.equal(unifiedDiff("x.md", "same", "same\n"), "", "a missing final newline isn't a change");
  assert.equal(unifiedDiff("t.md", null, "one\ntwo\n"), ["--- /dev/null", "+++ b/t.md", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"));
  assert.equal(unifiedDiff("t.md", "one\n", null), ["--- a/t.md", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-one"].join("\n"));
});

test("line diff: changes far apart are separate hunks; close ones merge", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const after = [...lines];
  after[1] = "X";
  after[17] = "Y";
  const diff = unifiedDiff("f", `${lines.join("\n")}\n`, `${after.join("\n")}\n`);
  assert.deepEqual(diff.split("\n").filter((l) => l.startsWith("@@")), ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  after[8] = "Z";
  after[11] = "W";
  const merged = unifiedDiff("f", `${lines.join("\n")}\n`, `${after.join("\n")}\n`);
  assert.equal(merged.split("\n").filter((l) => l.startsWith("@@")).length, 1);
});

test("line diff: inserted and removed lines keep the rest as context", () => {
  const diff = unifiedDiff("f", "a\nb\nc\n", "a\nnew\nb\n");
  assert.equal(diff, ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "+new", " b", "-c"].join("\n"));
});
