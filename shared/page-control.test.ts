import assert from "node:assert/strict";
import { test } from "node:test";
import { actionChip, actionInputLine, actionResultLimit, MAX_ACTION_RESULT, MAX_PAGE_ACTIONS, rankActions, sanitizeActions } from "./actions.ts";
import { controlMessage, isPageControl, MAX_PAGE_READ_RESULT, pageRead, PRIVATE_SELECTOR, shownDescription, allowedToRun, pageControlConfirm, withPageControlConfirm, pointChip, pointOf, shownInput, reloadedResult, withoutPageControl } from "./page-control.ts";

const state = {
  url: "https://app.example.com/settings?token=abc123&tab=billing",
  title: "Settings for jane@example.com",
  header: "Current Page: [Settings for jane@example.com](https://app.example.com/settings?token=abc123&tab=billing)\nPage info: 1280x720px viewport",
  content: "[0]<input name=email value=jane@example.com />\nCard 4242 4242 4242 4242\n[1]<button >Save />",
  footer: "[End of page]",
};

test("pageRead: masks every string and drops the URL's query values", () => {
  const read = pageRead(state, "https://app.example.com");
  assert.equal(read.url, "https://app.example.com/settings?token=…&tab=…");
  assert.equal(read.title, "Settings for [email]");
  assert.ok(!read.header.includes("abc123") && !read.header.includes("jane@"), read.header);
  assert.ok(read.header.includes("(https://app.example.com/settings?token="), read.header);
  assert.ok(!read.content.includes("jane@example.com") && !read.content.includes("4242 4242"), read.content);
  assert.ok(read.content.includes("[1]<button >Save />"));
  assert.equal(read.footer, "[End of page]");
});

test("pageRead: a long page is cut so its JSON fits the cap, with a note", () => {
  const long = { ...state, content: Array.from({ length: 3000 }, (_, i) => `\t[${i}]<a >"Item" ${i} />`).join("\n") };
  const read = pageRead(long, "https://app.example.com");
  const json = JSON.stringify(read);
  assert.ok(json.length <= MAX_PAGE_READ_RESULT, String(json.length));
  assert.ok(json.length > MAX_PAGE_READ_RESULT - 400, "uses most of the room");
  assert.match(read.content, /the rest of the page was cut/);
  const small = pageRead(state, "https://app.example.com", 20000);
  assert.doesNotMatch(small.content, /cut/);
});

test("controlMessage: PageController's marks out, masked, one line", () => {
  assert.equal(controlMessage("✅ Scrolled page by 720px."), "Scrolled page by 720px.");
  assert.equal(controlMessage("❌ Failed to click element: Error: No interactive element found at index 9"), "Failed to click element: Error: No interactive element found at index 9");
  assert.equal(controlMessage("⚠️ Already at the bottom of the page"), "Already at the bottom of the page");
  assert.equal(controlMessage("Input text (me@x.io) into\nfield"), "Input text ([email]) into field");
});

test("page-control actions: recognised by name; the card shows the label, never the element number", () => {
  assert.ok(isPageControl("read_page") && isPageControl("click") && !isPageControl("export_csv") && !isPageControl(undefined));
  assert.deepEqual(shownInput({ name: "click", input: { index: 7, label: "Save button" } }), { label: "Save button" });
  assert.deepEqual(Object.keys(shownInput({ name: "type_text", input: { index: 3, text: "Acme", label: "Company name" } })), ["label", "text"]);
  assert.deepEqual(shownInput({ name: "add_label", input: { index: 7, label: "x" } }), { index: 7, label: "x" }, "other actions untouched");
  assert.equal(actionChip({ name: "click", input: { index: 7, label: "Save button" }, status: "pending", result: null }), "Save button");
  assert.equal(actionChip({ name: "read_page", input: {}, status: "ok", result: JSON.stringify({ url: "/x", content: "…" }) }), null, "the page's text never shows as a chip");
  assert.equal(shownDescription({ name: "click", description: "Click a button… by its number from read_page." }), "Click on this page");
  assert.equal(shownDescription({ name: "export_csv", description: "Download CSV" }), "Download CSV");
});

test("actionResultLimit: read_page gets a page's worth, everything else the usual cap", () => {
  assert.equal(actionResultLimit("read_page"), MAX_PAGE_READ_RESULT);
  assert.equal(actionResultLimit("click"), MAX_ACTION_RESULT);
  assert.equal(actionResultLimit("export_csv"), MAX_ACTION_RESULT);
});

test("rankActions: page control is always offered, after the site's own actions", () => {
  const site = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `site_${i}`, description: `Site action ${i}` }));
  const control = ["read_page", "click", "type_text", "choose_option", "scroll_page"].map((name) => ({ id: name, name, description: `Page control ${name}` }));
  const ranked = rankActions(sanitizeActions([...control, ...site]), "export my usage");
  assert.equal(ranked.length, MAX_PAGE_ACTIONS);
  assert.deepEqual(ranked.slice(-5).map((a) => a.name), ["read_page", "click", "type_text", "choose_option", "scroll_page"]);
  assert.equal(ranked[0]!.name, "site_0");
  // Without page control nothing changes.
  assert.equal(rankActions(sanitizeActions(site), "x").length, MAX_PAGE_ACTIONS);
});

test("PRIVATE_SELECTOR: the widget, data-jun-private and secret fields", () => {
  for (const part of ["[data-jun-desk]", "[data-jun-private]", "input[type=password]", "input[type=hidden]", '[autocomplete*="cc-"]', '[autocomplete*="one-time-code"]']) assert.ok(PRIVATE_SELECTOR.includes(part), part);
});

test("actionInputLine: page control shows what a person reads; other actions keep name: value", () => {
  assert.equal(actionInputLine({ name: "type_text", input: { index: 5, text: "Acme Ltd", label: "Company name field" } }), "Company name field · Acme Ltd");
  assert.equal(actionInputLine({ name: "upgrade_plan", input: { plan: "growth" } }), "plan: growth");
  assert.equal(actionInputLine({ name: "read_page", input: {} }), "");
});

test("withoutPageControl: the desk's switch off drops only the five page-control actions", () => {
  const list = [{ name: "export_csv" }, { name: "read_page" }, { name: "click" }, { name: "upgrade_plan" }, { name: "scroll_page" }];
  assert.deepEqual(withoutPageControl(list).map((a) => a.name), ["export_csv", "upgrade_plan"]);
  assert.deepEqual(withoutPageControl([{ name: "export_csv" }]), [{ name: "export_csv" }]);
});

test("reloadedResult: a page-control step cut off by a page load counts as done; any other action is checked", () => {
  assert.equal(reloadedResult("click").status, "ok");
  assert.match(reloadedResult("click").result, /read_page/);
  assert.equal(reloadedResult("upgrade_plan").status, "error");
  assert.match(reloadedResult("upgrade_plan").result, /may or may not/);
});

test("pointOf: only a click, typing or choice waiting on the visitor, with an element number", () => {
  const base = { status: "pending", risk: "confirm", missing: [] as string[], input: { index: 4, label: "Save button" } };
  assert.deepEqual(pointOf({ ...base, name: "click" }), { name: "click", index: 4, input: base.input });
  assert.equal(pointOf({ ...base, name: "read_page" }), null);
  assert.equal(pointOf({ ...base, name: "click", status: "ok" }), null);
  assert.equal(pointOf({ ...base, name: "click", risk: "auto" }), null);
  assert.equal(pointOf({ ...base, name: "click", missing: ["index"] }), null);
  assert.equal(pointOf({ ...base, name: "click", input: { label: "x" } }), null);
  assert.equal(pointOf(undefined), null);
});

test("pointChip: says what will happen, short, and where to confirm while it waits", () => {
  assert.equal(pointChip({ name: "click", input: {} }), "Click");
  assert.equal(pointChip({ name: "type_text", input: { text: "Acme   Ltd" } }), "Type “Acme Ltd”");
  assert.equal(pointChip({ name: "choose_option", input: { option: "Tokyo" } }, true), "Choose “Tokyo” · confirm in the chat");
  assert.ok(pointChip({ name: "type_text", input: { text: "x".repeat(99) } }).length < 50);
});

test("allowedToRun: Always allow lets page control's waiting steps run; nothing else changes", () => {
  const step = { name: "click", risk: "confirm", status: "pending" };
  assert.equal(allowedToRun(step).risk, "auto");
  assert.equal(allowedToRun({ ...step, name: "upgrade_plan" }).risk, "confirm");
  assert.equal(allowedToRun({ ...step, risk: "human" }).risk, "human");
  assert.equal(allowedToRun({ ...step, status: "ok" }).risk, "confirm");
  const done = { ...step, status: "cancelled" };
  assert.equal(allowedToRun(done), done);
});

test("pageControlConfirm: the desk's choice; Don't ask makes only page control's waiting steps run at once", () => {
  assert.equal(pageControlConfirm(undefined), "allow-always");
  assert.equal(pageControlConfirm("never"), "never");
  assert.equal(pageControlConfirm("bogus"), "allow-always");
  const list = [{ name: "click", risk: "confirm" }, { name: "upgrade_plan", risk: "confirm" }, { name: "type_text", risk: "human" }];
  assert.deepEqual(withPageControlConfirm(list, "never").map((a) => a.risk), ["auto", "confirm", "human"]);
  assert.equal(withPageControlConfirm(list, "every-time"), list);
});
