import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceSummary, type WorkspaceSummaryRow } from "./workspace-summary.ts";

const row = (over: Partial<WorkspaceSummaryRow> = {}): WorkspaceSummaryRow => ({
  workspaceId: "ws_a",
  workspaceName: "Acme",
  workspaceSlug: "acme",
  role: "owner",
  widgetKey: "wk_1",
  settings: "{}",
  installMarked: null,
  aiEnabled: 0,
  open: 0,
  waiting: 0,
  ...over,
});

test("a workspace's card: colour, logos, install, numbers", () => {
  const s = workspaceSummary(row({
    settings: JSON.stringify({ color: "#FF0000", logoKey: "logo_x", installedAt: 1, installedOn: "acme.com" }),
    aiEnabled: 1,
    open: 4,
    waiting: 2,
  }));
  assert.equal(s.color, "#ff0000");
  assert.equal(s.logoUrl, "/api/widget/wk_1/logo?v=logo_x");
  assert.equal(s.logoDarkUrl, null);
  assert.equal(s.installedOn, "acme.com");
  assert.equal(s.installed, true);
  assert.deepEqual([s.open, s.waiting, s.aiOn], [4, 2, true]);
});

test("defaults: no settings, no install, AI off", () => {
  const s = workspaceSummary(row({ settings: null, aiEnabled: null, open: null, waiting: null }));
  assert.equal(s.color, "#2f5bea");
  assert.equal(s.logoUrl, null);
  assert.deepEqual([s.installed, s.installedOn, s.open, s.waiting, s.aiOn], [false, null, 0, 0, false]);
  // Unreadable settings and a bad colour fall back too.
  assert.equal(workspaceSummary(row({ settings: "{oops", })).color, "#2f5bea");
  assert.equal(workspaceSummary(row({ settings: JSON.stringify({ color: "red" }) })).color, "#2f5bea");
});

test("ticked by hand: installed, with no host", () => {
  const s = workspaceSummary(row({ installMarked: "1" }));
  assert.deepEqual([s.installed, s.installedOn], [true, null]);
  // No widget key: no logo URL even with a logo key.
  assert.equal(workspaceSummary(row({ widgetKey: null, settings: JSON.stringify({ logoKey: "k" }) })).logoUrl, null);
});
