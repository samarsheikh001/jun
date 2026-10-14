// End-to-end test of D-86, the desk's MCP server (POST /mcp): a person's own AI changes the support
// agent over JSON-RPC with an API token. Protocol (initialize, tools/list, resources, 401/405), the
// typed tools (task, action on httpbin.org, widget from a gallery template, test case), check and
// dryRun (nothing saved), preview_widget, desk.yaml applied to the widget's public config, History
// showing the MCP as the source, restore, and set_key never returning a key. Real AI only for one
// test_chat turn (E2E_AI_PROVIDER, default ChatGPT). D-87: the knowledge tools (a Markdown document indexed
// and found by search_knowledge, a member's token reads but can't add, remove_source needs confirm, a
// website accepted); search embeds through Workers AI, so this needs Cloudflare access.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const run = Date.now().toString(36);

const ECHO_URL = process.env.ECHO_URL ?? "https://httpbin.org/anything";
const MCP = `${BASE}/mcp`;
const GREETING = `Hi from MCP ${Date.now()}`;

const owner = new Client();
let workspaceId = "";
let widgetKey = "";
let token = "";
let originalGreeting = "";
let id = 0;
/** Every tool answer, to check a key never comes back. */
const answers: string[] = [];

async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}, as = token) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${as}`, "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function tool(name: string, args: Record<string, unknown> = {}, as = token): Promise<{ text: string; isError: boolean }> {
  const res = await rpc("tools/call", { name, arguments: args }, {}, as);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json?.result, `${name}: ${JSON.stringify(res.json)}`);
  const text = (res.json!.result.content as { text: string }[]).map((c) => c.text).join("\n");
  answers.push(text);
  return { text, isError: res.json!.result.isError === true };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await tool(name, args);
  assert.equal(r.isError, false, `${name}: ${r.text}`);
  return r.text;
};
const liveVersion = async () => (await owner.call(`/workspaces/${workspaceId}/agent`)).json.version as number | null;
const widgetConfig = async () => (await new Client().call(`/widget/${widgetKey}/config`)).json;

await step("owner signs in, turns the AI on and creates an API token", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  const inbox = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox;
  widgetKey = inbox.widgetKey;
  originalGreeting = (await widgetConfig()).greeting ?? "";
  await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 1000 } });
  token = (await owner.call(`/workspaces/${workspaceId}/tokens`, { body: { name: "e2e mcp" } })).json.token;
  assert.match(token, /^jun_/);
  // Leftovers of an earlier run that stopped halfway (the e2e database is kept between runs).
  const live = (await owner.call(`/workspaces/${workspaceId}/agent`)).json as { version: number | null; files: Record<string, string> };
  const files = Object.fromEntries(Object.entries(live.files).filter(([p]) => !/mcp[-_]|tests\/mcp\.yaml/.test(p)));
  if (Object.keys(files).length !== Object.keys(live.files).length) {
    const actions = Object.keys(files).filter((p) => p.startsWith("actions/"));
    for (const p of actions) files[p] = files[p]!.replace(/^widget: mcp_\w+\n/m, "");
    assert.equal((await owner.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: live.version, message: "e2e-mcp: clean up" } })).status, 200);
  }
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  await tool("set_website_action", { name: "add_to_cart", run: null, status: null });
});

await step("without a token: 401 with WWW-Authenticate and where to get one; a bad token too; GET is 405", async () => {
  const none = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.match(((await none.json()) as { error: { message: string } }).error.message, /Settings → Developer → API tokens/);
  assert.equal((await rpc("ping", undefined, { authorization: "Bearer jun_nope" })).status, 401);
  const get = await fetch(MCP, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
  assert.equal(get.status, 405);
  assert.equal((await rpc("ping", undefined, { origin: "https://evil.example" })).status, 403);
});

await step("initialize, notifications/initialized, tools/list with every group, resources", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.json!.result.protocolVersion, "2025-06-18");
  assert.equal(init.json!.result.serverInfo.name, "jun");
  assert.match(init.json!.result.instructions, /support agent/);
  assert.equal((await rpc("initialize", { protocolVersion: "2099-01-01" })).json!.result.protocolVersion, "2025-11-25");
  const note = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const tools = (await rpc("tools/list")).json!.result.tools as { name: string; inputSchema: { type: string } }[];
  const names = tools.map((t) => t.name);
  for (const name of ["get_agent", "read_file", "write_file", "check", "history", "restore", "connections", "update_instructions", "create_task", "task_uses", "create_action", "action_from_curl", "try_action", "action_status", "set_key", "create_widget", "widget_templates", "preview_widget", "widget_from_data", "add_test_case", "run_tests", "test_chat", "website_actions", "set_website_action", "get_desk_settings", "update_desk_settings", "list_knowledge", "add_website", "add_document", "resync_source", "remove_source", "search_knowledge"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(tools.every((t) => t.inputSchema.type === "object" && /^[a-z_]+$/.test(t.name)));
  const resources = (await rpc("resources/list")).json!.result.resources as { uri: string }[];
  assert.ok(resources.some((r) => r.uri === "jun://guide/files"));
  assert.ok(resources.some((r) => r.uri === "jun://file/instructions.md"));
  const guide = (await rpc("resources/read", { uri: "jun://guide/files" })).json!.result.contents[0];
  assert.match(guide.text, /actions\/<name>\.yaml/);
  assert.match((await rpc("resources/read", { uri: "jun://guide/jinja" })).json!.result.contents[0].text, /tojson/);
  assert.equal((await rpc("resources/read", { uri: "jun://file/nope.md" })).json!.error.code, -32002);
  assert.equal((await rpc("tools/call", { name: "no_such_tool", arguments: {} })).json!.error.code, -32602);
});

let before: number | null = null;

await step("dryRun saves nothing; check and a bad write report problems file by file, nothing saved", async () => {
  before = await liveVersion();
  const dry = await ok("create_task", { name: "mcp-refunds", description: "The customer asks for a refund.", steps: ["Ask for the order number.", "Look it up with @mcp_order_lookup."], dryRun: true });
  assert.match(dry, /Dry run, nothing saved/);
  assert.match(dry, /description: The customer asks for a refund\./);
  assert.equal(await liveVersion(), before);
  const checked = await ok("check", { files: { "actions/broken.yaml": "url: nope" } });
  assert.match(checked, /actions\/broken\.yaml: .*description is required/);
  const bad = await tool("write_file", { path: "actions/broken.yaml", content: "url: nope" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Nothing was saved/);
  const wrongPath = await tool("write_file", { path: "notes.txt", content: "hi" });
  assert.equal(wrongPath.isError, true);
  assert.equal(await liveVersion(), before);
  // Input problems come back as tool errors the AI can fix.
  const missing = await tool("create_task", { name: "x" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /description is required/);
});

let afterAction = 0;

await step("create_action (httpbin), create_task using it, create_widget from a template, add_test_case: each a version", async () => {
  const action = await ok("create_action", {
    name: "mcp_order_lookup",
    description: "Look up an order by its number. Returns its status and delivery estimate (eta).",
    status: "Checking your order",
    url: `${ECHO_URL}/orders/{orderNumber}`,
    query: { status: "shipped", eta: "Friday" },
    headers: { "X-Api-Key": "{secrets.E2E_ORDERS_KEY}" },
    input: { orderNumber: { type: "string", description: "The order number, like A-1042" } },
    pick: ["args"],
  });
  assert.match(action, /Saved version \d+, live now: add action mcp_order_lookup/);
  // The key isn't stored yet: a warning, saved anyway.
  assert.match(action, /The key E2E_ORDERS_KEY isn't added yet/);
  afterAction = (await liveVersion())!;
  const task = await ok("create_task", { name: "mcp-refunds", description: "The customer asks for a refund or their money back.", steps: ["Ask for the order number if you don't have it.", "Look it up with @mcp_order_lookup.", "Hand off to a person with the order number in the reason."] });
  assert.match(task, /add task mcp-refunds/);
  const uses = await ok("task_uses", { name: "mcp-refunds" });
  assert.match(uses, /mcp_order_lookup/);
  const widget = await ok("create_widget", { name: "mcp_ride", fromTemplate: "ride_status", title: "Your ride" });
  assert.match(widget, /add widget mcp_ride/);
  const preview = await ok("preview_widget", { name: "mcp_ride" });
  assert.match(preview, /^No problems\./);
  assert.match(preview, /Card:\n(Card|ListView|Basic)/);
  assert.match(preview, new RegExp(`/agent/widgets/mcp_ride`));
  const test = await ok("add_test_case", { file: "mcp", name: "refund goes to a person", message: "I want my money back for order A-1042", expect: { outcome: "handoff" } });
  assert.match(test, /tests\/mcp\.yaml \(new\)/);
  const files = (await owner.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>;
  assert.match(files["tasks/mcp-refunds.md"]!, /^---\ndescription: The customer asks for a refund or their money back\.\n---\n1\. Ask for the order number/);
  assert.equal(JSON.parse(files["widgets/mcp_ride.widget"]!).name, "Your ride");
  // A field edit keeps the file's comments.
  await ok("write_file", { path: "actions/mcp_order_lookup.yaml", content: `${files["actions/mcp_order_lookup.yaml"]}# keep this comment\n` });
  await ok("update_action", { name: "mcp_order_lookup", status: "Finding your order" });
  const after = (await ok("get_action", { name: "mcp_order_lookup" }));
  assert.match(after, /# keep this comment/);
  assert.match(after, /status: Finding your order/);
});

await step("History shows the MCP as the source; restore brings an old version back as a new one", async () => {
  const history = await ok("history", { limit: 10 });
  assert.match(history, /an AI \(MCP\) · /);
  const versions = (await owner.call(`/workspaces/${workspaceId}/agent`)).json.versions as { source: string; message: string }[];
  assert.equal(versions[0]!.source, "mcp");
  assert.match(versions.find((v) => v.message === "MCP: add task mcp-refunds")!.message, /add task mcp-refunds/);
  const latest = (await liveVersion())!;
  const restored = await ok("restore", { version: afterAction, message: "e2e: back to just the action" });
  assert.match(restored, new RegExp(`Saved version ${latest + 1}`));
  const files = (await owner.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>;
  assert.equal(files["tasks/mcp-refunds.md"], undefined);
  assert.ok(files["actions/mcp_order_lookup.yaml"]);
  await ok("restore", { version: latest });
  assert.ok(((await owner.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>)["tasks/mcp-refunds.md"]);
});

await step("update_desk_settings changes the widget's public config (desk.yaml applied like a save)", async () => {
  const dry = await ok("update_desk_settings", { chat: { greeting: GREETING }, dryRun: true });
  assert.match(dry, new RegExp(`greeting: ${GREETING}`));
  assert.notEqual((await widgetConfig()).greeting, GREETING);
  const saved = await ok("update_desk_settings", { chat: { greeting: GREETING } });
  assert.match(saved, /desk\.yaml/);
  assert.equal((await widgetConfig()).greeting, GREETING);
  const settings = await ok("get_desk_settings");
  assert.match(settings, new RegExp(`greeting: ${GREETING}`));
  const bad = await tool("update_desk_settings", { chat: { launcher: "rocket" } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /desk\.yaml/);
});

const KEY = "e2e-secret-value-9f8e7d6c";

await step("set_key stores a key that no tool ever returns; the action is ready and try_action calls it", async () => {
  const set = await ok("set_key", { name: "E2E_ORDERS_KEY", value: KEY });
  assert.match(set, /ends in 7d6c/);
  const status = await ok("action_status", { name: "mcp_order_lookup" });
  assert.match(status, /mcp_order_lookup: ready/);
  assert.match(status, /E2E_ORDERS_KEY: stored on the desk, ends in 7d6c/);
  const tried = await ok("try_action", { name: "mcp_order_lookup", input: { orderNumber: "A-1042" } });
  assert.match(tried, /^OK \(HTTP 200\)/);
  assert.match(tried, /shipped/);
  await ok("get_agent");
  await ok("read_file", { path: "actions/mcp_order_lookup.yaml" });
  await ok("connections");
  for (const text of answers) assert.ok(!text.includes(KEY), "a tool returned the key");
  // A key name that isn't UPPER_SNAKE_CASE is refused.
  assert.equal((await tool("set_key", { name: "bad-name", value: "x" })).isError, true);
});

await step("website-actions.yaml through set_website_action; widget_from_data makes a card from a result", async () => {
  const set = await ok("set_website_action", { name: "add_to_cart", run: "auto", status: "Adding it to your cart" });
  assert.match(set, /add_to_cart:\n {2}run: auto\n {2}status: Adding it to your cart/);
  await ok("set_website_action", { name: "add_to_cart", run: null, status: null });
  const files = (await owner.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>;
  // Cleared again (a file that had comments of its own keeps them).
  assert.ok(!(files["website-actions.yaml"] ?? "").includes("add_to_cart"));
  const card = await ok("widget_from_data", { name: "mcp_order_card", data: { status: "shipped", eta: "Friday", items: [{ name: "Mug", qty: 2 }] }, attachTo: "mcp_order_lookup" });
  assert.match(card, /add widget mcp_order_card shown by mcp_order_lookup/);
  assert.match(await ok("preview_widget", { name: "mcp_order_card" }), /^No problems\./);
});

await step("test_chat: one real AI turn with the saved agent (safe mode)", async () => {
  const chat = await ok("test_chat", { messages: ["Where is my order A-1042?"] });
  assert.match(chat, /Customer: Where is my order A-1042\?\nAI reply 1:/);
  assert.match(chat, /pass these turns back/);
});

const PHRASE = `quokka-${run}`;
const MARK = `MCP doc ${run}`;
let docId = "";
let siteId = "";

await step("knowledge: add_document (Markdown) is indexed, listed and found by search_knowledge", async () => {
  // Leftovers of an earlier run.
  for (const line of (await ok("list_knowledge")).split("\n").filter((l) => /MCP doc |example\.com/.test(l))) {
    const id = /- (src_[\w-]+)/.exec(line)?.[1];
    if (id) await ok("remove_source", { id, confirm: true });
  }
  const both = await tool("add_document", { name: MARK, text: "x", base64: "eA==", filename: "x.txt" });
  assert.equal(both.isError, true);
  assert.match(both.text, /not both/);
  const added = await ok("add_document", { name: MARK, text: `# Pet policy

## Office animals

The only animal allowed in the Glimmer office is a ${PHRASE}, and it must wear a name badge on Thursdays.
` });
  docId = /\((src_[\w-]+),/.exec(added)?.[1] ?? "";
  assert.ok(docId, added);
  assert.match(added, /markdown/);
  const deadline = Date.now() + 90_000;
  let line = "";
  for (;;) {
    line = (await ok("list_knowledge")).split("\n").find((l) => l.includes(docId)) ?? "";
    assert.ok(line, "listed");
    if (/ · (ready|failed) · /.test(line) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.match(line, / · file · "MCP doc [^"]+" \(MCP doc [^)]+\.md\) · ready · /);
  assert.match(line, /[1-9]\d* chunks?/);
  const found = await ok("search_knowledge", { query: `Which animal is allowed in the Glimmer office? ${PHRASE}` });
  assert.match(found, new RegExp(PHRASE));
  assert.match(found, new RegExp(`source ${docId} "${MARK}"`));
  assert.match(found, /score -?\d/);
});

await step("knowledge: a member's token searches and lists, but can't add, re-sync or remove", async () => {
  const teammate = new Client();
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const inviteToken = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${inviteToken}`, new SoftAuthenticator(), { name: `Mo ${run}`, email: `mo-${run}@acme.test` })).status, 200);
  const memberToken = (await teammate.call(`/workspaces/${workspaceId}/tokens`, { body: { name: "e2e mcp member" } })).json.token as string;
  assert.match(memberToken, /^jun_/);
  assert.match((await tool("search_knowledge", { query: PHRASE }, memberToken)).text, new RegExp(PHRASE));
  assert.equal((await tool("list_knowledge", {}, memberToken)).isError, false);
  for (const [name, args] of [["add_document", { name: "nope", text: "nope" }], ["add_website", { url: "https://example.com" }], ["resync_source", { id: docId }], ["remove_source", { id: docId, confirm: true }]] as const) {
    const refused = await tool(name, args, memberToken);
    assert.equal(refused.isError, true, name);
    assert.match(refused.text, /Only owners and admins/);
  }
  // The token reaches knowledge only through the MCP: the REST knowledge routes want a session.
  const rest = await fetch(`${BASE}/api/workspaces/${workspaceId}/knowledge`, { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(rest.status, 401);
});

await step("knowledge: add_website is accepted and listed; resync_source; bad input is refused", async () => {
  const bad = await tool("add_website", { url: "ftp://example.com" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /full URL/);
  const added = await ok("add_website", { url: "https://example.com/", maxPages: 1 });
  siteId = /\((src_[\w-]+)\)/.exec(added)?.[1] ?? "";
  assert.ok(siteId, added);
  assert.match(added, /Added the page example\.com/);
  assert.match(await ok("list_knowledge"), new RegExp(`${siteId} · page · https://example\\.com/ · (queued|crawling|ready|failed)`));
  assert.match(await ok("resync_source", { id: docId }), /Re-indexing/);
  assert.equal((await tool("resync_source", { id: "src_nope" })).isError, true);
});

await step("knowledge: remove_source without confirm is refused; with confirm it's gone", async () => {
  const unconfirmed = await tool("remove_source", { id: docId });
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.text, /can't be undone/);
  assert.match(unconfirmed.text, /confirm: true/);
  assert.match(await ok("list_knowledge"), new RegExp(docId));
  assert.match(await ok("remove_source", { id: docId, confirm: true }), /Removed/);
  assert.match(await ok("remove_source", { id: siteId, confirm: true }), /Removed/);
  const list = await ok("list_knowledge");
  assert.ok(!list.includes(docId) && !list.includes(siteId), list);
  assert.equal((await tool("remove_source", { id: docId, confirm: true })).isError, true);
  assert.doesNotMatch(await ok("search_knowledge", { query: PHRASE }), new RegExp(PHRASE));
});

await step("clean up: the greeting and the test's files", async () => {
  await ok("update_desk_settings", { chat: { greeting: originalGreeting } });
  for (const [name, args] of [["delete_widget", { name: "mcp_ride" }], ["delete_task", { name: "mcp-refunds" }], ["delete_test_case", { file: "mcp", name: "refund goes to a person" }]] as const) await ok(name, args);
  await ok("update_action", { name: "mcp_order_lookup", widget: null });
  await ok("delete_widget", { name: "mcp_order_card" });
  await ok("delete_action", { name: "mcp_order_lookup" });
  await ok("set_key", { name: "E2E_ORDERS_KEY", remove: true });
  assert.equal((await widgetConfig()).greeting ?? "", originalGreeting);
});

summary();
