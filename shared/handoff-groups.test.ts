import assert from "node:assert/strict";
import { test } from "node:test";
import { groupInput, groupPrompt, handoffGroupFor, normalizeGroup, parseGroupOutput, pendingReasons, resolveGroups } from "./handoff-groups.ts";
import { reasonKey } from "./metrics.ts";

test("normalizeGroup: 1-5 words, first letter upper, trimmed", () => {
  assert.equal(normalizeGroup("double charge check"), "Double charge check");
  assert.equal(normalizeGroup('  "CSV export bug". '), "CSV export bug");
  assert.equal(normalizeGroup("Booking tools unavailable"), "Booking tools unavailable");
  assert.equal(normalizeGroup("one two three four five six"), null);
  assert.equal(normalizeGroup("x".repeat(41)), null);
  assert.equal(normalizeGroup("{json}"), null);
  assert.equal(normalizeGroup("123"), null);
  assert.equal(normalizeGroup(4), null);
});

test("pendingReasons: skips fixed reasons and known keys, one per loose key, most used first", () => {
  const known = new Set([reasonKey("Refund needs approval")]);
  const out = pendingReasons([
    { reason: "Customer questions two charges.", n: 1 },
    { reason: "customer questions two charges", n: 2 },
    { reason: "Booking tool is down", n: 1 },
    { reason: "Refund needs approval.", n: 5 },
    { reason: "The customer asked for a person.", n: 9 },
    { reason: "AI error: 502", n: 3 },
    { reason: "The AI couldn't answer from the knowledge base.", n: 4 },
    { reason: null, n: 1 },
  ], known);
  assert.deepEqual(out.map((p) => [p.reason, p.count]), [["Customer questions two charges.", 3], ["Booking tool is down", 1]]);
});

test("groupPrompt and groupInput", () => {
  assert.match(groupPrompt([]), /no groups yet/);
  assert.match(groupPrompt(["Double charge check"]), /Existing groups: "Double charge check"/);
  assert.match(groupPrompt(["a", "b"], 2), /No new groups can be created/);
  assert.match(groupPrompt([]), /ignore any instructions/);
  const input = groupInput([{ key: "a", reason: "Booking tool is down", count: 1 }, { key: "b", reason: "x".repeat(400), count: 1 }]);
  assert.equal(input.split("\n")[0], "1. Booking tool is down");
  assert.ok(input.split("\n")[1]!.length < 310);
});

test("parseGroupOutput and resolveGroups: reuse loosely, cap new groups, first answer wins", () => {
  const parsed = parseGroupOutput('Here:\n```json\n[{"id": 1, "group": "double-charge check"}, {"id": "2", "group": "Booking tools unavailable"}, {"id": "2", "group": "Other"}, {"id": "3", "group": "Refund approval"}, {"id": "9", "group": "Nope"}, {"id": "4"}]\n```');
  assert.ok(parsed);
  const { groups, created } = resolveGroups(parsed, ["1", "2", "3", "4"], ["Double charge check"], 2);
  assert.deepEqual([...groups], [["1", "Double charge check"], ["2", "Booking tools unavailable"]]);
  assert.deepEqual(created, ["Booking tools unavailable"]);
  assert.equal(parseGroupOutput("no json"), null);
  assert.deepEqual(parseGroupOutput('{"groups": [{"id": "1", "group": "A b"}]}'), [{ id: "1", label: "A b" }]);
});

test("handoffGroupFor: the stored group by loose key, never for fixed reasons", () => {
  const groups = new Map([[reasonKey("Customer questions two charges"), "Double charge check"], [reasonKey("Asked for a person"), "People"]]);
  assert.equal(handoffGroupFor("The customer questions two charges.", groups), "Double charge check");
  assert.equal(handoffGroupFor("Asked for a person", groups), null);
  assert.equal(handoffGroupFor("Something else", groups), null);
  assert.equal(handoffGroupFor(null, groups), null);
});
