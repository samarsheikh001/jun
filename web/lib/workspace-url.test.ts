import assert from "node:assert/strict";
import { test } from "node:test";
import { deskLocation, slugOf, withoutWorkspace, withWorkspace } from "./workspace-url.ts";

test("the workspace prefix comes off for pages and goes back on for links", () => {
  assert.equal(slugOf("/w/acme/inbox"), "acme");
  assert.equal(slugOf("/w/acme"), "acme");
  assert.equal(slugOf("/inbox"), null);
  assert.equal(slugOf("/web/x"), null);
  assert.equal(withoutWorkspace("/w/acme/inbox/cv_1"), "/inbox/cv_1");
  assert.equal(withoutWorkspace("/w/acme"), "/");
  assert.equal(withoutWorkspace("/w/acme/"), "/");
  assert.equal(withoutWorkspace("/inbox"), "/inbox");

  assert.equal(withWorkspace("/inbox/cv_1", "acme"), "/w/acme/inbox/cv_1");
  assert.equal(withWorkspace("/settings/integrations#issue-trackers", "acme"), "/w/acme/settings/integrations#issue-trackers");
  assert.equal(withWorkspace("/inbox?topic=t1", "acme"), "/w/acme/inbox?topic=t1");
  assert.equal(withWorkspace("/", "acme"), "/w/acme");
  assert.equal(withWorkspace("/inbox", null), "/inbox");
  // Already in a workspace, not a desk page, or not a path: unchanged.
  assert.equal(withWorkspace("/w/beta/inbox", "acme"), "/w/beta/inbox");
  for (const path of ["/api/files/x", "/mcp", "/widget?key=k", "/widget.js", "/invite/abc", "/recover", "/demo.html?key=k", "https://example.com/inbox", "//evil.test/x", "#top"]) {
    assert.equal(withWorkspace(path, "acme"), path);
  }
  // A page whose name starts like an excluded one is still a desk page.
  assert.equal(withWorkspace("/apis", "acme"), "/w/acme/apis");
});

const all = [
  { workspaceId: "ws_a", workspaceSlug: "acme" },
  { workspaceId: "ws_b", workspaceSlug: "beta" },
];
const at = (href: string) => {
  const u = new URL(href, "https://desk.test");
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};

test("a prefixed URL picks its workspace and stays as it is", () => {
  assert.deepEqual(deskLocation(all, at("/w/beta/agent/tasks"), "ws_a"), { workspace: all[1], url: null });
  assert.deepEqual(deskLocation(all, at("/w/beta/settings/team#invites"), null), { workspace: all[1], url: null });
  assert.deepEqual(deskLocation(all, at("/w/beta"), null), { workspace: all[1], url: "/w/beta/home" });
});

test("old URLs move under a workspace: ?ws=, else the last one used, else the first", () => {
  assert.deepEqual(deskLocation(all, at("/inbox/cv_1?ws=ws_b"), "ws_a"), { workspace: all[1], url: "/w/beta/inbox/cv_1" });
  assert.deepEqual(deskLocation(all, at("/settings/developer?x=1#api-tokens"), "ws_b"), { workspace: all[1], url: "/w/beta/settings/developer?x=1#api-tokens" });
  assert.deepEqual(deskLocation(all, at("/agent"), "ws_gone"), { workspace: all[0], url: "/w/acme/agent" });
  // ?ws= that isn't yours: dropped.
  assert.deepEqual(deskLocation(all, at("/inbox?ws=ws_x&topic=t"), null), { workspace: all[0], url: "/w/acme/inbox?topic=t" });
  // ?ws= on a prefixed URL wins (an older notification opened in a tab on another workspace).
  assert.deepEqual(deskLocation(all, at("/w/acme/inbox/cv_1?ws=ws_b"), null), { workspace: all[1], url: "/w/beta/inbox/cv_1" });
});

test("an unknown slug opens the first workspace's Home", () => {
  assert.deepEqual(deskLocation(all, at("/w/nope/agent"), "ws_b"), { workspace: all[0], url: "/w/acme/home" });
  assert.deepEqual(deskLocation([], at("/inbox"), null), { workspace: undefined, url: null });
});

test("the desk's home: / with two or more workspaces, Home with one", () => {
  assert.deepEqual(deskLocation(all, at("/"), "ws_b"), { workspace: undefined, url: null, home: true });
  assert.deepEqual(deskLocation(all, at("/settings/account"), null), { workspace: undefined, url: null, home: true });
  assert.deepEqual(deskLocation(all, at("/settings/desk/"), null), { workspace: undefined, url: null, home: true });
  // The workspace's own sections and ?ws= links still open a workspace.
  assert.deepEqual(deskLocation(all, at("/settings/team"), "ws_b"), { workspace: all[1], url: "/w/beta/settings/team" });
  assert.deepEqual(deskLocation(all, at("/?ws=ws_b"), null), { workspace: all[1], url: "/w/beta/home" });
  // Inside a workspace the same sections stay there.
  assert.deepEqual(deskLocation(all, at("/w/acme/settings/account"), null), { workspace: all[0], url: null });
  const one = [all[0]!];
  assert.deepEqual(deskLocation(one, at("/"), null), { workspace: all[0], url: "/w/acme/home" });
  assert.deepEqual(deskLocation(one, at("/settings/desk"), null), { workspace: all[0], url: "/w/acme/settings/desk" });
});
