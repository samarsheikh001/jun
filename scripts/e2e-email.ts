// End-to-end test of the email channel (C-02): settings, the widget's promise, a reply emailed to a
// customer who left (not to one still in the chat), and their email reply coming back into the chat
// through the Worker's email() handler (wrangler's local /cdn-cgi/handler/email). Needs a dev server
// started with JUN_EMAIL_DELAY_MS=3000 (emails after 3 s instead of 2 min):
//   JUN_STATE_DIR=.wrangler/e2e-state JUN_EMAIL_DELAY_MS=3000 npx vite --port 5174
// Local Email Sending accepts any address and writes the mail to a file; nothing leaves the machine.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const visitor = new Client();
const run = Date.now().toString(36);
const customer = `dana-${run}@northwind.test`;
const replyDomain = `reply-${run}.acme.test`;
let workspaceId = "";
let widgetKey = "";
let visitorToken = "";
let conversationId = "";
let replyTo = "";
const vh = () => ({ "X-Visitor-Token": visitorToken });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = { body: string; internal: boolean; authorType: string; attachments: { name: string }[]; meta: { via?: string } };
const agentMessages = async () => (await owner.call(`/conversations/${conversationId}`)).json.messages as Msg[];
const emailedNotes = async () => (await agentMessages()).filter((m) => m.internal && /^Emailed /.test(m.body));

/** Delivers a raw email to the Worker's email() handler, as Email Routing would. */
async function deliver(from: string, to: string, raw: string) {
  const url = `${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { method: "POST", body: raw.replace(/\n/g, "\r\n") });
  return { status: res.status, text: await res.text() };
}
const mail = (from: string, to: string, id: string, body: string, extra = "") =>
  `From: ${from}\nTo: ${to}\nSubject: Re: your conversation with Jun\nMessage-ID: <${id}@northwind.test>\nDate: ${new Date().toUTCString()}\n${extra}MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`;

/** One D1 read through the local explorer (the reply token isn't in any API, by design). */
async function sql<T>(query: string): Promise<T[]> {
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/DB/raw`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: query }) });
  const { columns, rows } = ((await res.json()) as { result: { results: { columns: string[]; rows: unknown[][] } }[] }).result[0]!.results;
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])) as T);
}

await step("owner signs in, the AI is off, a teammate joins", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: AI_PROVIDER } });
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Ola ${run}`, email: `ola-${run}@acme.test` })).status, 200);
});

await step("settings: checked, admins only, and the widget promises email only once it's on", async () => {
  const base = `/workspaces/${workspaceId}/email`;
  // Earlier runs on this database may have left it on: start from off.
  await owner.call(base, { method: "PUT", body: { enabled: false } });
  const before = (await owner.call(base)).json;
  assert.equal(before.on, false);
  assert.equal(before.canSend, true, "the dev server has the send_email binding");
  assert.equal((await owner.call(`/widget/${widgetKey}/config`)).json.emailReplies, false);
  assert.equal((await owner.call(base, { method: "PUT", body: { from: "nope" } })).status, 400);
  assert.equal((await owner.call(base, { method: "PUT", body: { from: "", replyDomain: "", enabled: true } })).status, 400);
  assert.equal((await teammate.call(base, { method: "PUT", body: { enabled: false } })).status, 403);
  assert.equal((await teammate.call(base)).status, 200, "agents can see it");
  const saved = await owner.call(base, { method: "PUT", body: { from: "Support@Acme.test", fromName: "Acme Support", replyDomain, enabled: true } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.on, true);
  assert.equal(saved.json.settings.from, "support@acme.test");
  assert.equal(saved.json.replyExample, `c-…@${replyDomain}`);
  assert.equal((await owner.call(`/widget/${widgetKey}/config`)).json.emailReplies, true);
  const test = await owner.call(`${base}/test`, { body: { to: `owner-${run}@acme.test` } });
  assert.equal(test.status, 200, JSON.stringify(test.json));
});

await step("a reply isn't emailed while the customer is still in the chat", async () => {
  visitorToken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  const conv = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "My invoice export fails" }, headers: vh() });
  assert.equal(conv.status, 200, JSON.stringify(conv.json));
  conversationId = conv.json.conversation.id;
  assert.equal((await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/email`, { body: { email: customer }, headers: vh() })).status, 200);
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=100000`, { protocols: [visitorToken] });
  await socket.opened;
  const reply = await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Looking into it now." } });
  const seen = await socket.next((e) => e.type === "message" && e.message.body === "Looking into it now.");
  socket.send({ type: "read", seq: seen.message.seq });
  await wait(5000);
  assert.equal((await emailedNotes()).length, 0, "they were there");
  assert.ok(reply.json.message);
  socket.close();
  await socket.closed;
});

await step("replies to a customer who left go out as one email, and the team sees a note", async () => {
  await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Found it: a timeout on our side." } });
  await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Fixed. Can you try the export again?" } });
  // A note never goes out by email.
  await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "internal: deploy 4412", internal: true } });
  let notes: Msg[] = [];
  for (let i = 0; i < 20 && !notes.length; i++) {
    await wait(1000);
    notes = await emailedNotes();
  }
  assert.equal(notes.length, 1, "one email for both replies");
  assert.match(notes[0]!.body, new RegExp(`^Emailed 2 replies to ${customer.replace(/\./g, "\\.")}`));
  const transcript = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as Msg[];
  assert.ok(!transcript.some((m) => /^Emailed /.test(m.body)), "the note stays with the team");
  const [row] = await sql<{ email_token: string }>(`SELECT email_token FROM conversations WHERE id = '${conversationId}'`);
  assert.match(row!.email_token, /^[a-z0-9]{24}$/);
  replyTo = `c-${row!.email_token}@${replyDomain}`;
});

await step("the customer's email reply lands in the chat: new text only, files kept, conversation reopened", async () => {
  assert.equal((await owner.call(`/conversations/${conversationId}`, { method: "PATCH", body: { status: "resolved" } })).status, 200);
  const boundary = `b-${run}`;
  const raw = [
    `From: Dana <${customer}>`, `To: ${replyTo}`, "Subject: Re: your conversation with Jun", `Message-ID: <r1-${run}@northwind.test>`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "",
    "Still failing, log attached.", "", "Dana", "", `On Mon, 5 Oct 2026 at 10:00, Acme Support <${replyTo}> wrote:`, "> Fixed. Can you try the export again?", "",
    `--${boundary}`, "Content-Type: text/plain; name=\"export.log\"", "Content-Disposition: attachment; filename=\"export.log\"", "",
    "ERROR 504 at row 42", `--${boundary}--`, "",
  ].join("\n");
  const res = await deliver(customer, replyTo, raw);
  assert.equal(res.status, 200, res.text);
  const msgs = await agentMessages();
  const fromEmail = msgs.filter((m) => m.authorType === "visitor" && m.meta.via === "email");
  assert.equal(fromEmail.length, 1);
  assert.equal(fromEmail[0]!.body, "Still failing, log attached.\n\nDana");
  assert.deepEqual(fromEmail[0]!.attachments.map((a) => a.name), ["export.log"]);
  assert.equal((await owner.call(`/conversations/${conversationId}`)).json.conversation.status, "open");
  // The same delivery again (a retry) adds nothing.
  assert.equal((await deliver(customer, replyTo, raw)).status, 200);
  assert.equal((await agentMessages()).filter((m) => m.meta.via === "email").length, 1);
});

await step("mail from another address is a note; automatic mail and unknown addresses never reach the chat", async () => {
  assert.equal((await deliver(`boss-${run}@northwind.test`, replyTo, mail(`boss-${run}@northwind.test`, replyTo, `o-${run}`, "Please escalate this."))).status, 200);
  const note = (await agentMessages()).find((m) => m.internal && /Please escalate this\./.test(m.body));
  assert.ok(note, "a note for the team");
  const transcript = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as Msg[];
  assert.ok(!transcript.some((m) => /escalate/.test(m.body)));

  const before = (await agentMessages()).length;
  assert.equal((await deliver(customer, replyTo, mail(customer, replyTo, `a-${run}`, "I'm out of office.", "Auto-Submitted: auto-replied\n"))).status, 200);
  assert.equal((await agentMessages()).length, before, "an out-of-office is dropped quietly");

  const unknown = await deliver(customer, `c-${"x".repeat(24)}@${replyDomain}`, mail(customer, "x", `u-${run}`, "hi"));
  assert.notEqual(unknown.status, 200);
  assert.match(unknown.text, /No such address/);
  const wrongDomain = await deliver(customer, replyTo.replace(replyDomain, "other.test"), mail(customer, "x", `w-${run}`, "hi"));
  assert.match(wrongDomain.text, /doesn't take replies/);
});

await step("turned off: no promise in the widget and replies are refused", async () => {
  const off = await owner.call(`/workspaces/${workspaceId}/email`, { method: "PUT", body: { enabled: false } });
  assert.equal(off.json.on, false);
  assert.equal((await owner.call(`/widget/${widgetKey}/config`)).json.emailReplies, false);
  const refused = await deliver(customer, replyTo, mail(customer, replyTo, `off-${run}`, "Hello?"));
  assert.match(refused.text, /doesn't take replies/);
});

summary();
