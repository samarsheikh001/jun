// End-to-end test of team replies from Slack (C-09 / T-13, D-152) against a fake Slack in this process:
// connecting (keys checked, admins only, the URL check), picking a channel, a chat that needs a person
// opening a thread (card + what was said so far), the chat following in the thread, a teammate's thread
// reply reaching the customer as them (once, even when Slack retries), people who aren't teammates,
// edits, the card's buttons, the internal-note shortcut and modal, forged requests, a broken connection
// and disconnecting. Needs a dev server pointed at the fake Slack:
//   JUN_STATE_DIR=.wrangler/e2e-state SLACK_API_URL=http://127.0.0.1:8790/api npx vite --port 5174
// then: BASE_URL=http://localhost:5174 node scripts/e2e-slack.ts

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const run = Date.now().toString(36);
const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = `xoxb-e2e-${run}-abcdefghij`;
const TEAM = "T0E2E";
const BOT = "U0BOT";
const OLA = "U0OLA";
const STRANGER = "U0STRANGER";
const olaEmail = `ola-${run}@acme.test`;

// ---------- the fake Slack ----------

interface Call { method: string; body: Record<string, any> }
const calls: Call[] = [];
let ts = 1_800_000_000;
let failPosts: string | null = null;
const nextTs = () => `${ts++}.000100`;
const users: Record<string, { name: string; email: string }> = {
  [OLA]: { name: "ola", email: olaEmail },
  [STRANGER]: { name: "guest", email: `guest-${run}@elsewhere.test` },
};
const channels = [
  { id: "C0SUPPORT", name: "support", is_private: false, is_member: false, is_archived: false },
  { id: "G0SECRET", name: "secret", is_private: true, is_member: false, is_archived: false },
];

const slack = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const method = (req.url ?? "").replace(/^\/api\//, "");
  const body = (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
  calls.push({ method, body });
  const send = (json: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ ok: false, error: "invalid_auth" });
  switch (method) {
    case "auth.test": return send({ ok: true, team_id: TEAM, team: "Acme", url: "https://acme.slack.com/", user_id: BOT });
    case "conversations.list": return send({ ok: true, channels, response_metadata: { next_cursor: "" } });
    case "conversations.info": {
      const ch = channels.find((c) => c.id === body.channel);
      return send(ch ? { ok: true, channel: ch } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.join": {
      const ch = channels.find((c) => c.id === body.channel)!;
      ch.is_member = true;
      return send({ ok: true, channel: ch });
    }
    case "chat.postMessage":
      if (failPosts) return send({ ok: false, error: failPosts });
      return send({ ok: true, channel: body.channel, ts: nextTs() });
    case "chat.update":
    case "chat.postEphemeral":
    case "views.open":
      return send({ ok: true });
    case "users.info": return send({ ok: true, user: { name: users[body.user]!.name, profile: { email: users[body.user]!.email, display_name: users[body.user]!.name } } });
    default: return send({ ok: false, error: "unknown_method" });
  }
});
await new Promise<void>((resolve) => slack.listen(8790, "127.0.0.1", resolve));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, find: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    const found = await find();
    if (found) return found;
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const posts = () => calls.filter((c) => c.method === "chat.postMessage");

// ---------- signed requests from "Slack" ----------

async function signature(timestamp: string, body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function fromSlack(path: string, body: string, contentType: string, opts: { secret?: string; retry?: boolean } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${BASE}/api/slack/${workspaceId}/${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signature(timestamp, body, opts.secret),
      ...(opts.retry ? { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } : {}),
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}
let eventCount = 0;
const event = (inner: Record<string, unknown>, eventId = `Ev${run}${eventCount++}`) =>
  fromSlack("events", JSON.stringify({ type: "event_callback", team_id: TEAM, event_id: eventId, event: { channel: "C0SUPPORT", ...inner } }), "application/json");
const action = (payload: Record<string, unknown>) =>
  fromSlack("actions", new URLSearchParams({ payload: JSON.stringify({ team: { id: TEAM }, ...payload }) }).toString(), "application/x-www-form-urlencoded");

// ---------- the desk ----------

const owner = new Client();
const teammate = new Client();
const visitor = new Client();
let workspaceId = "";
let widgetKey = "";
let visitorToken = "";
let conversationId = "";
let ownerName = "";
let threadTs = "";
const vh = () => ({ "X-Visitor-Token": visitorToken });
type Msg = { body: string; internal: boolean; authorType: string; authorName: string | null; meta: { via?: string } };
const deskMessages = async () => (await owner.call(`/conversations/${conversationId}`)).json.messages as Msg[];
const inThread = () => posts().filter((c) => c.body.thread_ts === threadTs);

try {
  await step("a new workspace with the AI off, and a teammate whose email Slack knows", async () => {
    assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
    const me = (await owner.call("/me")).json;
    ownerName = me.user.name;
    const created = await owner.call("/workspaces", { body: { name: `Slack ${run}` } });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    workspaceId = created.json.workspaceId;
    widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
    const ai = await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: "workers-ai" } });
    assert.equal(ai.status, 200, JSON.stringify(ai.json));
    const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
    const token = new URL(invite.json.url).pathname.split("/").pop()!;
    assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Ola ${run}`, email: olaEmail })).status, 200);
  });

  await step("before connecting: the manifest link, and Slack's URL check answered", async () => {
    const view = (await owner.call(`/workspaces/${workspaceId}/slack`)).json;
    assert.equal(view.connected, false);
    assert.equal(view.local, true);
    const manifest = JSON.parse(decodeURIComponent(view.manifestUrl.split("manifest_json=")[1]));
    assert.equal(manifest.settings.event_subscriptions.request_url, `${new URL(BASE).origin}/api/slack/${workspaceId}/events`);
    // Slack checks the URL while the app is being created, before the secret is pasted here.
    const check = await fetch(`${BASE}/api/slack/${workspaceId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "abc123" }) });
    assert.deepEqual(await check.json(), { challenge: "abc123" });
  });

  await step("connecting: keys checked with Slack, admins only, never shown again", async () => {
    const base = `/workspaces/${workspaceId}/slack`;
    assert.equal((await teammate.call(`${base}/keys`, { method: "PUT", body: { token: TOKEN, signingSecret: SECRET } })).status, 403);
    assert.equal((await owner.call(`${base}/keys`, { method: "PUT", body: { token: "xoxp-nope", signingSecret: SECRET } })).status, 400);
    const wrong = await owner.call(`${base}/keys`, { method: "PUT", body: { token: `xoxb-wrong-${run}-abcdefghij`, signingSecret: SECRET } });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error.message, /token/);
    const ok = await owner.call(`${base}/keys`, { method: "PUT", body: { token: TOKEN, signingSecret: SECRET } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.teamName, "Acme");
    assert.equal(ok.json.tokenLast4, TOKEN.slice(-4));
    assert.ok(!JSON.stringify(ok.json).includes(TOKEN) && !JSON.stringify(ok.json).includes(SECRET));
    const forAgent = (await teammate.call(base)).json;
    assert.equal(forAgent.connected, true);
    assert.equal(forAgent.tokenLast4, null);
    // Now that there's a secret, an unsigned URL check is refused.
    const unsigned = await fetch(`${BASE}/api/slack/${workspaceId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "x" }) });
    assert.equal(unsigned.status, 401);
    const signed = await fromSlack("events", JSON.stringify({ type: "url_verification", challenge: "x2" }), "application/json");
    assert.equal(signed.text, JSON.stringify({ challenge: "x2" }));
  });

  await step("picking a channel: a private one needs the bot invited, a public one is joined and greeted", async () => {
    const base = `/workspaces/${workspaceId}/slack`;
    const list = (await owner.call(`${base}/channels`)).json.channels;
    assert.deepEqual(list.map((c: { name: string }) => c.name), ["secret", "support"]);
    const secret = await owner.call(base, { method: "PUT", body: { channelId: "G0SECRET" } });
    assert.equal(secret.status, 400);
    assert.match(secret.json.error.message, /\/invite @Jun/);
    const ok = await owner.call(base, { method: "PUT", body: { channelId: "C0SUPPORT" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.channel, { id: "C0SUPPORT", name: "support" });
    assert.ok(calls.some((c) => c.method === "conversations.join" && c.body.channel === "C0SUPPORT"));
    assert.ok(posts().some((c) => c.body.channel === "C0SUPPORT" && /Jun is connected/.test(c.body.text)));
    assert.equal((await owner.call(base, { method: "PUT", body: { mode: "sometimes" } })).status, 400);
  });

  await step("a chat for the team opens a thread: the card, then what was said so far", async () => {
    visitorToken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
    const conv = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "My invoice export <fails> & times out" }, headers: vh() });
    assert.equal(conv.status, 200, JSON.stringify(conv.json));
    conversationId = conv.json.conversation.id;
    const root = await until("the thread's card", () => posts().find((c) => c.body.channel === "C0SUPPORT" && Array.isArray(c.body.blocks)));
    const card = JSON.stringify(root.body.blocks);
    assert.match(card, /Waiting for the team/);
    assert.match(card, new RegExp(`/inbox/${conversationId}`));
    const rows = await until("the thread row", async () => {
      const r = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/DB/raw`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: `SELECT thread_ts FROM slack_threads WHERE conversation_id = '${conversationId}'` }) });
      return ((await r.json()) as { result: { results: { rows: string[][] } }[] }).result[0]!.results.rows[0];
    });
    threadTs = rows[0]!;
    const backfill = await until("the backfill", () => inThread().find((c) => /Earlier in this chat/.test(c.body.text)));
    assert.match(backfill.body.text, /My invoice export &lt;fails&gt; &amp; times out/);
    assert.equal(posts().filter((c) => Array.isArray(c.body.blocks) && c.body.channel === "C0SUPPORT").length, 1, "one thread per chat");
  });

  await step("the chat follows in the thread: the customer, the desk's replies and notes", async () => {
    await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Any news?" }, headers: vh() });
    const fromVisitor = await until("the customer's message", () => inThread().find((c) => c.body.text === "Any news?"));
    assert.match(fromVisitor.body.username, /\(customer\)$/);
    await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Checking the logs now." } });
    const reply = await until("the desk's reply", () => inThread().find((c) => c.body.text === "Checking the logs now."));
    assert.equal(reply.body.username, ownerName);
    await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "deploy 4412 broke it", internal: true } });
    const note = await until("the note", () => inThread().find((c) => /deploy 4412/.test(c.body.text)));
    assert.match(note.body.text, /^🔒 \*Note\*/);
  });

  await step("a teammate's reply in the thread reaches the customer as them, once", async () => {
    const before = posts().length;
    const tsOla = nextTs();
    const id = `EvOla${run}`;
    assert.equal((await event({ type: "message", user: OLA, text: "Fixed &amp; deployed, see <https://status.acme.test|status>", ts: tsOla, thread_ts: threadTs }, id)).status, 200);
    const msg = await until("Ola's reply in the desk", async () => (await deskMessages()).find((m) => m.meta.via === "slack"));
    assert.equal(msg.body, "Fixed & deployed, see status (https://status.acme.test)");
    assert.equal(msg.authorType, "agent");
    assert.equal(msg.authorName, `Ola ${run}`);
    assert.equal(msg.internal, false);
    const seen = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as Msg[];
    assert.ok(seen.some((m) => m.body === msg.body), "the customer has it");
    // Slack retries the same event; and the same message under another event id.
    await fromSlack("events", JSON.stringify({ type: "event_callback", team_id: TEAM, event_id: id, event: { type: "message", channel: "C0SUPPORT", user: OLA, text: "Fixed", ts: tsOla, thread_ts: threadTs } }), "application/json", { retry: true });
    await event({ type: "message", user: OLA, text: "Fixed &amp; deployed", ts: tsOla, thread_ts: threadTs });
    await wait(1500);
    assert.equal((await deskMessages()).filter((m) => m.meta.via === "slack").length, 1);
    assert.ok(!posts().slice(before).some((c) => /Fixed/.test(c.body.text ?? "")), "not posted back into Slack");
  });

  await step("ignored: forged requests, bots (ourselves too), messages outside a thread, other Slack workspaces", async () => {
    const forged = await fromSlack("events", JSON.stringify({ type: "event_callback", team_id: TEAM, event_id: `EvF${run}`, event: { type: "message", channel: "C0SUPPORT", user: OLA, text: "forged", ts: nextTs(), thread_ts: threadTs } }), "application/json", { secret: "f".repeat(32) });
    assert.equal(forged.status, 401);
    await event({ type: "message", user: BOT, bot_id: "B1", text: "from a bot", ts: nextTs(), thread_ts: threadTs });
    await event({ type: "message", user: OLA, text: "top level", ts: nextTs() });
    await fromSlack("events", JSON.stringify({ type: "event_callback", team_id: "T0OTHER", event_id: `EvO${run}`, event: { type: "message", channel: "C0SUPPORT", user: OLA, text: "other team", ts: nextTs(), thread_ts: threadTs } }), "application/json");
    await wait(1500);
    const bodies = (await deskMessages()).map((m) => m.body);
    for (const text of ["forged", "from a bot", "top level", "other team"]) assert.ok(!bodies.includes(text), text);
  });

  await step("someone who isn't a teammate: told in Slack, kept as a note, the customer doesn't get it", async () => {
    await event({ type: "message", user: STRANGER, text: "I can help!", ts: nextTs(), thread_ts: threadTs });
    const told = await until("the ephemeral", () => calls.find((c) => c.method === "chat.postEphemeral" && c.body.user === STRANGER));
    assert.match(told.body.text, /didn't go to the customer/);
    const note = await until("the note", async () => (await deskMessages()).find((m) => m.internal && /I can help!/.test(m.body)));
    assert.match(note.body, /isn't a teammate/);
    const seen = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as Msg[];
    assert.ok(!seen.some((m) => /I can help/.test(m.body)));
  });

  await step("an edit after sending: Slack says the customer has the first version", async () => {
    const sent = (await deskMessages()).find((m) => m.meta.via === "slack")!;
    assert.ok(sent);
    const first = calls.length;
    const original = (await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/DB/raw`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: `SELECT client_msg_id FROM messages WHERE conversation_id = '${conversationId}' AND json_extract(meta, '$.via') = 'slack'` }) }).then((r) => r.json())) as { result: { results: { rows: string[][] } }[] };
    const editedTs = original.result[0]!.results.rows[0]![0]!.replace(/^slack:/, "");
    await event({ type: "message", subtype: "message_changed", message: { user: OLA, text: "Fixed and deployed!", ts: editedTs, thread_ts: threadTs }, previous_message: { text: "Fixed" } });
    const told = await until("the ephemeral", () => calls.slice(first).find((c) => c.method === "chat.postEphemeral" && c.body.user === OLA));
    assert.match(told.body.text, /first version/);
  });

  await step("the card's buttons: assign to me, close; the card follows", async () => {
    assert.equal((await action({ type: "block_actions", user: { id: OLA }, actions: [{ action_id: "jun_assign", value: conversationId }] })).status, 200);
    const assigned = await until("the assignment", async () => {
      const c = (await owner.call(`/conversations/${conversationId}`)).json.conversation;
      return c.assigneeId ? c : null;
    });
    const me = (await teammate.call("/me")).json.user;
    assert.equal(assigned.assigneeId, me.id);
    await until("the card update", () => calls.find((c) => c.method === "chat.update" && c.body.ts === threadTs && new RegExp(`Ola ${run} has it`).test(JSON.stringify(c.body.blocks))));
    await action({ type: "block_actions", user: { id: OLA }, actions: [{ action_id: "jun_close", value: conversationId }] });
    await until("closed", async () => (await owner.call(`/conversations/${conversationId}`)).json.conversation.status === "resolved");
    await until("the card shows Reopen", () => calls.find((c) => c.method === "chat.update" && /jun_reopen/.test(JSON.stringify(c.body.blocks))));
    // A stranger's press does nothing.
    await action({ type: "block_actions", user: { id: STRANGER }, actions: [{ action_id: "jun_reopen", value: conversationId }] });
    await wait(1500);
    assert.equal((await owner.call(`/conversations/${conversationId}`)).json.conversation.status, "resolved");
  });

  await step("Add internal note: the shortcut opens a modal, and the note lands in the desk and the thread", async () => {
    const outside = await action({ type: "message_action", callback_id: "jun_note", trigger_id: "tr1", user: { id: OLA }, channel: { id: "C0SUPPORT" }, message: { ts: "1.0" } });
    assert.equal(outside.status, 200);
    assert.ok(!calls.some((c) => c.method === "views.open"), "no modal outside a chat's thread");
    await action({ type: "message_action", callback_id: "jun_note", trigger_id: "tr2", user: { id: OLA }, channel: { id: "C0SUPPORT" }, message: { ts: nextTs(), thread_ts: threadTs } });
    const modal = calls.find((c) => c.method === "views.open");
    assert.ok(modal, "the modal opened before Slack's answer");
    assert.equal(JSON.parse(modal.body.view.private_metadata).c, conversationId);
    const submit = (text: string, user = OLA) =>
      action({ type: "view_submission", user: { id: user }, view: { id: `V${run}${user}`, callback_id: "jun_note_modal", private_metadata: modal.body.view.private_metadata, state: { values: { note: { text: { value: text } } } } } });
    const refused = await submit("from a stranger", STRANGER);
    assert.match(refused.text, /response_action/);
    assert.equal((await submit("Customer is on the Enterprise plan")).status, 200);
    const note = await until("the note in the desk", async () => (await deskMessages()).find((m) => m.body === "Customer is on the Enterprise plan"));
    assert.equal(note.internal, true);
    assert.equal(note.authorName, `Ola ${run}`);
    await until("the note in the thread", () => inThread().find((c) => /^🔒 \*Note\*[\s\S]*Enterprise plan/.test(c.body.text)));
    const seen = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as Msg[];
    assert.ok(!seen.some((m) => /Enterprise/.test(m.body)), "the customer never sees it");
  });

  await step("a broken connection is shown to the admin and fixed by picking the channel again", async () => {
    failPosts = "channel_not_found";
    await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Still there?" }, headers: vh() });
    const view = await until("broken", async () => {
      const v = (await owner.call(`/workspaces/${workspaceId}/slack`)).json;
      return v.status === "broken" ? v : null;
    });
    assert.match(view.lastError, /channel is gone/);
    failPosts = null;
    const fixed = await owner.call(`/workspaces/${workspaceId}/slack`, { method: "PUT", body: { channelId: "C0SUPPORT" } });
    assert.equal(fixed.json.status, "connected");
  });

  await step("disconnecting forgets the keys: Slack's calls are refused", async () => {
    const off = await owner.call(`/workspaces/${workspaceId}/slack`, { method: "DELETE" });
    assert.equal(off.json.connected, false);
    assert.equal((await event({ type: "message", user: OLA, text: "late", ts: nextTs(), thread_ts: threadTs })).status, 401);
  });

  summary();
} finally {
  slack.close();
}
