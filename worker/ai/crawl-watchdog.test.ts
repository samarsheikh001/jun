import assert from "node:assert/strict";
import { test } from "node:test";
import { interruptedNote, STUCK_AFTER_MS, syncIsStuck } from "./crawl-watchdog.ts";

const now = Date.UTC(2026, 9, 14, 12);

test("a sync is stuck only when its newest sign of life is older than 20 minutes", () => {
  assert.equal(syncIsStuck(now, [now - 60_000]), false);
  assert.equal(syncIsStuck(now, [now - STUCK_AFTER_MS]), false);
  assert.equal(syncIsStuck(now, [now - STUCK_AFTER_MS - 1]), true);
  // The newest signal wins: an old start with a page just finished is still running.
  assert.equal(syncIsStuck(now, [now - 4 * 86_400_000, now - 5 * 60_000]), false);
  assert.equal(syncIsStuck(now, [now - 4 * 86_400_000, now - 4 * 86_400_000 + 18_000]), true);
  // Missing signals are ignored; none at all counts as stuck.
  assert.equal(syncIsStuck(now, [null, undefined, now - 60_000]), false);
  assert.equal(syncIsStuck(now, [null, undefined]), true);
  assert.equal(syncIsStuck(now, []), true);
});

test("the note an interrupted sync leaves", () => {
  assert.equal(interruptedNote(174, 0), null);
  assert.equal(interruptedNote(174, 26), "Finished with 26 pages not read (the crawl was interrupted). Sync again to retry them.");
  assert.equal(interruptedNote(3, 1), "Finished with 1 page not read (the crawl was interrupted). Sync again to retry it.");
  assert.match(interruptedNote(0, 73)!, /interrupted before any page was read/);
});
