// End-to-end test of a forwarded support inbox (C-13): the forwarding address, Gmail's confirmation,
// a forwarded email becoming a ticket (sender from the From: header, never verified), the team's reply
// emailed under the ticket's subject, the customer's next email threading back by Message-ID, a retried
// delivery adding nothing, and Mark as spam. Delivers through wrangler's local /cdn-cgi/handler/email.
// Same dev server as e2e-email.ts:
//   JUN_STATE_DIR=.wrangler/e2e-state JUN_EMAIL_DELAY_MS=3000 npx vite --port 5174

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
const customer = `rae-${run}@globex.test`;
const forwarder = `support-bounces-${run}@acme.test`;
const replyDomain = `reply-${run}.acme.test`;
const subject = `Export stuck at 99% ${run}`;
let workspaceId = "";
let address = "";
let ticketId = "";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = { body: string; internal: boolean; authorType: string; attachments: { name: string }[]; meta: { via?: string } };
const messages = async (id: string) => (await owner.call(`/conversations/${id}`)).json.messages as Msg[];

async function deliver(from: string, to: string, raw: string) {
  const url = `${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { method: "POST", body: raw.replace(/\n/g, "\r\n") });
  return { status: res.status, text: await res.text() };
}
/** A customer's email as a support inbox forwards it: the envelope is the forwarder's, From: is the customer's. */
const forwarded = (from: string, id: string, body: string, extra = "") =>
  `From: Rae Jones <${from}>\nTo: Acme Support <support@acme.test>\nSubject: ${subject}\nMessage-ID: <${id}@globex.test>\nDate: ${new Date().toUTCString()}\nAuto-Submitted: auto-forwarded\n${extra}MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`;

async function sql<T>(query: string): Promise<T[]> {
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/DB/raw`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: query }) });
  const { columns, rows } = ((await res.json()) as { result: { results: { columns: string[]; rows: unknown[][] } }[] }).result[0]!.results;
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])) as T);
}
const tickets = (email: string) =>
  sql<{ id: string; subject: string; type: string; status: string }>(
    `SELECT c.id, c.subject, c.type, c.status FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.email = '${email}' ORDER BY c.created_at`,
  );

await step("owner signs in, the AI is off, email replies are on, a teammate joins", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: AI_PROVIDER } });
  const saved = await owner.call(`/workspaces/${workspaceId}/email`, { method: "PUT", body: { from: "support@acme.test", fromName: "Acme Support", replyDomain, enabled: true } });
  assert.equal(saved.json.on, true, JSON.stringify(saved.json));
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Ola ${run}`, email: `ola-${run}@acme.test` })).status, 200);
});

await step("forwarding: admins turn it on and get an address; a new address replaces the old", async () => {
  const base = `/workspaces/${workspaceId}/email/forwarding`;
  assert.equal((await teammate.call(base, { method: "PUT", body: { enabled: true } })).status, 403);
  const on = await owner.call(base, { method: "PUT", body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.forwarding.enabled, true);
  assert.match(on.json.forwarding.address, new RegExp(`^reply\\+in-[a-z0-9]{24}@${replyDomain.replace(/\./g, "\\.")}$`));
  const rotated = await owner.call(base, { method: "PUT", body: { rotate: true } });
  assert.notEqual(rotated.json.forwarding.address, on.json.forwarding.address);
  const old = await deliver(forwarder, on.json.forwarding.address, forwarded(customer, `old-${run}`, "hi"));
  assert.match(old.text, /No such address/, "the old address stops working");
  address = rotated.json.forwarding.address;
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/email`)).json.forwarding.address, address, "agents see it");
});

await step("Gmail's confirmation shows on the page and is never a ticket", async () => {
  const raw = `From: Gmail Team <forwarding-noreply@google.com>\nTo: ${address}\nSubject: (#4815162342) Gmail Forwarding Confirmation - Receive Mail from support@acme.test\nMessage-ID: <g-${run}@google.com>\nMIME-Version: 1.0\nContent-Type: text/plain\n\nConfirmation code: 4815162342\n\nhttps://mail-settings.google.com/mail/vf-abc-${run}\n`;
  assert.equal((await deliver("forwarding-noreply@google.com", address, raw)).status, 200);
  const status = (await owner.call(`/workspaces/${workspaceId}/email`)).json;
  assert.equal(status.forwarding.confirmation.code, "4815162342");
  assert.equal(status.forwarding.confirmation.link, `https://mail-settings.google.com/mail/vf-abc-${run}`);
  assert.equal((await tickets("forwarding-noreply@google.com")).length, 0);
  const cleared = await owner.call(`/workspaces/${workspaceId}/email/forwarding`, { method: "PUT", body: { clearConfirmation: true } });
  assert.equal(cleared.json.forwarding.confirmation, null);
});

await step("a forwarded email becomes a ticket from the customer in From:, unverified, with its subject and Cc", async () => {
  const res = await deliver(forwarder, address, forwarded(customer, `m1-${run}`, "The export has been stuck at 99% since this morning.\n\n-- \nRae Jones\nGlobex", `Cc: lee-${run}@globex.test\n`));
  assert.equal(res.status, 200, res.text);
  const found = await tickets(customer);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.type, "ticket");
  assert.equal(found[0]!.subject, subject);
  ticketId = found[0]!.id;
  const conv = (await owner.call(`/conversations/${ticketId}`)).json;
  assert.equal(conv.conversation.type, "ticket");
  assert.equal(conv.conversation.subject, subject);
  assert.equal(conv.conversation.contact.email, customer);
  assert.equal(conv.conversation.contact.name, "Rae Jones");
  assert.equal(conv.conversation.contact.verified, false);
  const msgs = conv.messages as Msg[];
  const first = msgs.find((m) => m.authorType === "visitor")!;
  assert.match(first.body, /^The export has been stuck at 99% since this morning\./);
  assert.equal(first.meta.via, "email");
  assert.ok(msgs.some((m) => m.internal && m.body.startsWith(`Also sent to: lee-${run}@globex.test`)), "Cc'd people are a note");
  // The inbox's Chats / Emails filter.
  const listed = async (type: string) => (await owner.call(`/workspaces/${workspaceId}/conversations?status=all&type=${type}`));
  const emails = await listed("ticket");
  assert.ok((emails.json.conversations as { id: string; type: string }[]).some((x) => x.id === ticketId && x.type === "ticket"));
  assert.ok(!((await listed("chat")).json.conversations as { id: string }[]).some((x) => x.id === ticketId));
  assert.equal((await listed("fax")).status, 400);
  // A retried delivery is the same message, not a second ticket.
  assert.equal((await deliver(forwarder, address, forwarded(customer, `m1-${run}`, "The export has been stuck at 99% since this morning."))).status, 200);
  assert.equal((await tickets(customer)).length, 1);
});

await step("the team's reply is emailed; the customer's answer through support@ threads back by Message-ID", async () => {
  await owner.call(`/conversations/${ticketId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Thanks Rae, we restarted the export job." } });
  let emailed: Msg | undefined;
  for (let i = 0; i < 20 && !emailed; i++) {
    await wait(1000);
    emailed = (await messages(ticketId)).find((m) => m.internal && /^Emailed the reply to /.test(m.body));
  }
  assert.ok(emailed, "a ticket has no widget tab, so the reply goes out by email");
  const ids = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM email_messages WHERE conversation_id = '${ticketId}'`);
  assert.ok(ids[0]!.n >= 2, "the received and the sent Message-IDs are kept");
  const answer = forwarded(customer, `m2-${run}`, `It works now, thanks!\n\nOn Tue, Rae Jones <${customer}> wrote:\n> The export has been stuck`, `In-Reply-To: <m1-${run}@globex.test>\nReferences: <m1-${run}@globex.test>\n`);
  assert.equal((await deliver(forwarder, address, answer)).status, 200);
  assert.equal((await tickets(customer)).length, 1, "no second ticket");
  const visitorLines = (await messages(ticketId)).filter((m) => m.authorType === "visitor").map((m) => m.body);
  assert.deepEqual(visitorLines.slice(-1), ["It works now, thanks!"], "the quote is cut");
});

await step("automatic mail and blocked senders open no ticket; Mark as spam closes the ticket", async () => {
  const bot = `news-${run}@globex.test`;
  assert.equal((await deliver(forwarder, address, forwarded(bot, `n-${run}`, "Our newsletter", "List-Id: <news.globex.test>\n"))).status, 200);
  assert.equal((await tickets(bot)).length, 0, "list mail is dropped");

  const spammer = `deals-${run}@spam-${run}.test`;
  assert.equal((await deliver(forwarder, address, forwarded(spammer, `s1-${run}`, "Cheap followers"))).status, 200);
  const [spam] = await tickets(spammer);
  assert.ok(spam);
  const marked = await teammate.call(`/conversations/${spam.id}/spam`, { body: { scope: "domain" } });
  assert.equal(marked.status, 200, JSON.stringify(marked.json));
  assert.equal(marked.json.conversation.status, "resolved");
  assert.equal(marked.json.blocked, `@spam-${run}.test`);
  const other = `more-${run}@spam-${run}.test`;
  assert.equal((await deliver(forwarder, address, forwarded(other, `s2-${run}`, "More deals"))).status, 200, "accepted, never bounced");
  assert.equal((await tickets(other)).length, 0);
  const blocked = (await owner.call(`/workspaces/${workspaceId}/email/blocked`)).json.blocked as { pattern: string }[];
  assert.ok(blocked.some((b) => b.pattern === `@spam-${run}.test`));
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/email/blocked?pattern=${encodeURIComponent(`@spam-${run}.test`)}`, { method: "DELETE" })).status, 403);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/email/blocked?pattern=${encodeURIComponent(`@spam-${run}.test`)}`, { method: "DELETE" })).status, 200);

  // A widget chat can't be marked as spam.
  const chats = await sql<{ id: string }>(`SELECT id FROM conversations WHERE workspace_id = '${workspaceId}' AND type = 'chat' LIMIT 1`);
  if (chats[0]) assert.equal((await owner.call(`/conversations/${chats[0].id}/spam`, { body: {} })).status, 400);
});

await step("turned off: the address refuses mail", async () => {
  const off = await owner.call(`/workspaces/${workspaceId}/email/forwarding`, { method: "PUT", body: { enabled: false } });
  assert.equal(off.json.forwarding.enabled, false);
  const refused = await deliver(forwarder, address, forwarded(customer, `off-${run}`, "Hello?"));
  assert.match(refused.text, /doesn't take email/);
});

summary();
