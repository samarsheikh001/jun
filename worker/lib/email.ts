import PostalMime from "postal-mime";
import {
  emailOn, emailSettings, forwardingSettings, gmailConfirmation, htmlToText, isAutomatic, isBlocked, isEmail, MAX_EMAILS_PER_DAY, MAX_TICKETS_PER_DAY,
  MAX_TICKETS_PER_SENDER_HOUR, messageIds, newReplyToken, parseForwardAddress, parseReplyAddress, renderReplyEmail, replyAddress, replyText, sameMailbox,
  threadHeaders, ticketSubject, type EmailSettings, type ForwardingSettings,
} from "../../shared/email.ts";
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, MAX_UPLOAD_BYTES, type Attachment, type Message } from "../../shared/protocol.ts";
import { loadAiSettings } from "../ai/providers.ts";
import type { ConversationRef } from "../conversation.ts";
import { linkPerson } from "./contacts.ts";
import { loadMessages } from "./conversations.ts";
import { newId, randomToken, sha256 } from "./crypto.ts";

// C-02 / W-08: the email channel's Worker side. Sending goes through the `send_email` binding (Email
// Sending); replies arrive at the Worker's email() handler (Email Routing). Settings: shared/email.ts.

/** Whether this deploy has the binding at all (an older wrangler.jsonc, or a test, may not). */
export const canSendEmail = (env: Env) => typeof (env as Partial<Env>).EMAIL?.send === "function";

/** The workspace's email settings and the desk's own address (for file links), from the widget inbox. */
export async function loadEmailSettings(
  db: D1Database,
  workspaceId: string,
): Promise<{ inboxId: string; settings: EmailSettings; forwarding: ForwardingSettings; deskUrl: string | null } | null> {
  const row = await db.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>();
  if (!row) return null;
  const all = JSON.parse(row.settings) as { email?: unknown; emailForwarding?: unknown; emailDeskUrl?: unknown };
  return {
    inboxId: row.id,
    settings: emailSettings(all.email),
    forwarding: forwardingSettings(all.emailForwarding),
    deskUrl: typeof all.emailDeskUrl === "string" ? all.emailDeskUrl : null,
  };
}

export class EmailSendError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Email Sending's error codes, as a line for the admin (the Channels page, a note in the chat). */
function sendProblem(error: unknown): EmailSendError {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "E_UNKNOWN";
  const reasons: Record<string, string> = {
    E_SENDER_NOT_VERIFIED: "the from address's domain isn't verified for Email Sending yet",
    E_SENDER_DOMAIN_NOT_AVAILABLE: "the from address's domain isn't onboarded to Email Sending",
    E_RECIPIENT_NOT_ALLOWED: "this Cloudflare account may only send to verified addresses (Email Sending needs the Workers Paid plan to send to anyone)",
    E_RECIPIENT_SUPPRESSED: "that address bounced or complained before, so Cloudflare won't send to it",
    E_RATE_LIMIT_EXCEEDED: "Cloudflare's sending rate limit was hit; it will be tried with the next reply",
    E_DAILY_LIMIT_EXCEEDED: "the account's daily sending limit is reached",
  };
  return new EmailSendError(code, reasons[code] ?? `Email Sending refused it (${code}${error instanceof Error ? `: ${error.message}` : ""})`);
}

export async function sendEmail(
  env: Env,
  settings: EmailSettings,
  senderName: string,
  email: { to: string; subject: string; text: string; html: string; replyTo?: string; headers?: Record<string, string> },
): Promise<string> {
  if (!canSendEmail(env)) throw new EmailSendError("E_NO_BINDING", "this desk has no send_email binding");
  try {
    const result = await env.EMAIL.send({
      to: email.to,
      from: { email: settings.from, name: settings.fromName || senderName },
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      // Marks the mail as ours, so a bounce or autoresponder sending it back is never a message (isAutomatic).
      headers: { "X-Jun-Desk": "1", ...email.headers },
    });
    return result.messageId;
  } catch (error) {
    throw sendProblem(error);
  }
}

/** What the Conversation DO keeps between emails (its own storage). */
export interface EmailStore {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}
export const EMAIL_SENT_KEY = "email:sentThrough";
export const EMAIL_IDS_KEY = "email:ids";
const EMAIL_DAY_KEY = "email:day";

/**
 * Emails the replies the customer hasn't seen (the team's and the AI's, public, after what they've read
 * and what was emailed before) when email is on and they have an address. Returns the note for agents,
 * or null when there was nothing to send. Throws EmailSendError when sending failed.
 */
export async function emailUnseenReplies(env: Env, ref: ConversationRef, store: EmailStore): Promise<{ note: string; through: number } | null> {
  const row = await env.DB.prepare(
    `SELECT c.email_token, c.visitor_read_seq, c.subject, ct.email, w.name AS workspace_name
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`,
  )
    .bind(ref.conversationId)
    .first<{ email_token: string | null; visitor_read_seq: number; subject: string | null; email: string | null; workspace_name: string }>();
  if (!row?.email) return null;
  const loaded = await loadEmailSettings(env.DB, ref.workspaceId);
  if (!loaded || !emailOn(loaded.settings, canSendEmail(env))) return null;

  const since = Math.max(store.get<number>(EMAIL_SENT_KEY) ?? 0, row.visitor_read_seq);
  const replies = (await loadMessages(env.DB, ref.conversationId, { since, limit: 20, includeInternal: false })).filter(emailable);
  if (!replies.length) return null;
  const through = replies[replies.length - 1]!.seq;

  const day = new Date().toISOString().slice(0, 10);
  const sentToday = store.get<{ day: string; count: number }>(EMAIL_DAY_KEY);
  const count = sentToday?.day === day ? sentToday.count : 0;
  if (count >= MAX_EMAILS_PER_DAY) return null;

  const token = row.email_token ?? (await ensureToken(env.DB, ref.conversationId));
  const files = (m: Message) => (loaded.deskUrl ? m.attachments.map((a) => ({ name: a.name, url: `${loaded.deskUrl}/api/files/${a.key}` })) : []);
  const email = renderReplyEmail({
    workspaceName: row.workspace_name,
    subject: row.subject,
    messages: replies.map((m) => ({ author: m.authorType === "ai" ? row.workspace_name : m.authorName ?? row.workspace_name, body: m.body, files: files(m) })),
  });
  const ids = store.get<string[]>(EMAIL_IDS_KEY) ?? [];
  const messageId = await sendEmail(env, loaded.settings, row.workspace_name, {
    to: row.email,
    replyTo: replyAddress(token, loaded.settings.replyDomain),
    ...email,
    // RFC 3834: autoresponders shouldn't answer it (the customer's own reply is welcome).
    headers: { ...threadHeaders(ids), "Auto-Submitted": "auto-generated" },
  });
  store.put(EMAIL_SENT_KEY, through);
  store.put(EMAIL_IDS_KEY, [...ids, messageId].slice(-10));
  await recordMessageIds(env.DB, ref.workspaceId, ref.conversationId, [messageId]);
  store.put(EMAIL_DAY_KEY, { day, count: count + 1 });
  const n = replies.length;
  return { note: `Emailed ${n === 1 ? "the reply" : `${n} replies`} to ${row.email}: they weren't in the chat. Their answer by email comes back here.`, through };
}

/** Replies worth an email: the team's and the AI's words, not a website action's card. */
const emailable = (m: Message) => (m.authorType === "agent" || m.authorType === "ai") && !m.internal && !m.meta.action && m.body.trim().length > 0;

async function ensureToken(db: D1Database, conversationId: string): Promise<string> {
  await db.prepare("UPDATE conversations SET email_token = ? WHERE id = ? AND email_token IS NULL").bind(newReplyToken(), conversationId).run();
  const row = await db.prepare("SELECT email_token FROM conversations WHERE id = ?").bind(conversationId).first<{ email_token: string }>();
  return row!.email_token;
}

// ---------- inbound ----------

/** What the email() handler hands the Conversation DO. */
export interface InboundEmail {
  clientMsgId: string;
  messageId: string | null;
  from: string;
  /** The sender is the customer (their contact's address); else it's only a note for agents. */
  fromCustomer: boolean;
  body: string;
  attachments: Attachment[];
}

const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

/**
 * The Worker's email() handler: a reply to a conversation's address becomes the customer's message in
 * that chat (its new text only; files kept). Addresses we never gave out, and replies to a workspace
 * that turned email off, are refused; automatic mail is dropped quietly (no bounce, so no loop).
 */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const forward = parseForwardAddress(message.to);
  if (forward) return receiveForwarded(message, env, forward);
  const address = parseReplyAddress(message.to);
  if (!address) return message.setReject("No such address.");
  const row = await env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.contact_id, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.email_token = ?`,
  )
    .bind(address.token)
    .first<{ id: string; workspace_id: string; contact_id: string; email: string | null }>();
  if (!row) return message.setReject("No such address.");
  const loaded = await loadEmailSettings(env.DB, row.workspace_id);
  if (!loaded?.settings.enabled || loaded.settings.replyDomain !== address.domain) return message.setReject("This address doesn't take replies any more.");
  if (isAutomatic((name) => message.headers.get(name), message.from)) return;
  if (message.rawSize > MAX_INBOUND_BYTES) return message.setReject("The email is too large (25 MB at most).");

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);
  const text = parsed.text?.trim() ? parsed.text : htmlToText(parsed.html ?? "");
  const body = replyText(text).slice(0, MAX_MESSAGE_LENGTH);
  const fromCustomer = Boolean(row.email && sameMailbox(message.from, row.email));
  const attachments = fromCustomer ? await storeAttachments(env, row.workspace_id, row.contact_id, parsed.attachments) : [];
  if (!body && !attachments.length) return;

  const messageId = parsed.messageId ?? message.headers.get("message-id");
  const ref = { conversationId: row.id, workspaceId: row.workspace_id };
  await recordMessageIds(env.DB, row.workspace_id, row.id, messageIds(messageId));
  await env.CONVERSATION.getByName(row.id).receiveEmail(ref, row.contact_id, {
    // A retried delivery has the same Message-ID: one message.
    clientMsgId: `email:${messageId ? await sha256(messageId) : randomToken(16)}`,
    messageId,
    from: message.from,
    fromCustomer,
    body,
    attachments,
  });
}

// ---------- a forwarded support inbox (C-13) ----------

/** Message-IDs we've sent or received, hashed, so later mail can find its conversation. */
export async function recordMessageIds(db: D1Database, workspaceId: string, conversationId: string, ids: string[]): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    await db.prepare("INSERT OR IGNORE INTO email_messages (message_id_hash, workspace_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(id.replace(/^<|>$/g, "")), workspaceId, conversationId, now)
      .run();
  }
}

/** The conversation one of these Message-IDs belongs to (in this workspace), else null. */
async function threadOf(db: D1Database, workspaceId: string, ids: string[]): Promise<string | null> {
  const hashes = await Promise.all([...new Set(ids)].slice(0, 30).map((id) => sha256(id)));
  if (!hashes.length) return null;
  const row = await db.prepare(`SELECT conversation_id FROM email_messages WHERE workspace_id = ? AND message_id_hash IN (${hashes.map(() => "?").join(", ")}) LIMIT 1`)
    .bind(workspaceId, ...hashes)
    .first<{ conversation_id: string }>();
  return row?.conversation_id ?? null;
}

/** Changes the widget inbox's `emailForwarding` settings in place (one field). */
async function setForwardingField(db: D1Database, inboxId: string, field: "lastAt" | "confirmation", value: unknown): Promise<void> {
  await db.prepare(`UPDATE inboxes SET settings = json_set(settings, '$.emailForwarding.${field}', json(?)) WHERE id = ?`).bind(JSON.stringify(value), inboxId).run();
}

/**
 * C-13: mail a support inbox forwarded to `reply+in-<token>@<reply domain>`. A reply to one of our
 * emails (by its Message-ID) joins that conversation; anything else is a new ticket from the sender
 * in the `From:` header (after a forward, the envelope sender is the forwarder). Email contacts are
 * never verified (D-23). Gmail's forwarding confirmation is kept for the Channels page, never a ticket.
 */
async function receiveForwarded(message: ForwardableEmailMessage, env: Env, address: { token: string; domain: string }): Promise<void> {
  const inbox = await env.DB.prepare("SELECT id, workspace_id, settings FROM inboxes WHERE json_extract(settings, '$.emailForwarding.token') = ?")
    .bind(address.token)
    .first<{ id: string; workspace_id: string; settings: string }>();
  if (!inbox) return message.setReject("No such address.");
  const all = JSON.parse(inbox.settings) as { email?: unknown; emailForwarding?: unknown };
  const settings = emailSettings(all.email);
  if (!forwardingSettings(all.emailForwarding).enabled || !emailOn(settings, canSendEmail(env)) || settings.replyDomain !== address.domain) {
    return message.setReject("This address doesn't take email any more.");
  }
  if (message.rawSize > MAX_INBOUND_BYTES) return message.setReject("The email is too large (25 MB at most).");

  const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const from = (parsed.from?.address ?? message.from).trim().toLowerCase();
  const text = parsed.text?.trim() ? parsed.text : htmlToText(parsed.html ?? "");
  const confirmation = gmailConfirmation(from, parsed.subject ?? "", text);
  if (confirmation) return setForwardingField(env.DB, inbox.id, "confirmation", { ...confirmation, at: Date.now() });
  await setForwardingField(env.DB, inbox.id, "lastAt", Date.now());
  // Our own from address writing to support@ (a test, a loop) is never a customer.
  if (isAutomatic((name) => message.headers.get(name), from, { forwarded: true }) || !isEmail(from) || sameMailbox(from, settings.from)) return;
  const workspaceId = inbox.workspace_id;
  const blocked = await env.DB.prepare("SELECT pattern FROM blocked_senders WHERE workspace_id = ?").bind(workspaceId).all<{ pattern: string }>();
  // Accepted and dropped: a bounce would tell a spammer the block works.
  if (isBlocked(from, blocked.results.map((r) => r.pattern))) return;

  const messageId = parsed.messageId ?? message.headers.get("message-id");
  const own = messageIds(messageId);
  const replyTo = [...messageIds(parsed.inReplyTo), ...messageIds(parsed.references).reverse()];
  // Already here (a retried delivery; a reply-all copy that also came to the reply address), or a reply to our email.
  const existing = await threadOf(env.DB, workspaceId, [...own, ...replyTo]);
  const clientMsgId = `email:${messageId ? await sha256(messageId) : randomToken(16)}`;
  if (existing) {
    const row = await env.DB.prepare("SELECT c.contact_id, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ? AND c.workspace_id = ?")
      .bind(existing, workspaceId)
      .first<{ contact_id: string; email: string | null }>();
    if (!row) return;
    const fromCustomer = Boolean(row.email && sameMailbox(from, row.email));
    const body = replyText(text).slice(0, MAX_MESSAGE_LENGTH);
    const attachments = fromCustomer ? await storeAttachments(env, workspaceId, row.contact_id, parsed.attachments) : [];
    if (!body && !attachments.length) return;
    await recordMessageIds(env.DB, workspaceId, existing, own);
    await env.CONVERSATION.getByName(existing).receiveEmail({ conversationId: existing, workspaceId }, row.contact_id, { clientMsgId, messageId, from, fromCustomer, body, attachments });
    return;
  }

  // A new ticket, unless this sender (or everyone) has opened too many lately.
  const now = Date.now();
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
             WHERE c.workspace_id = ?1 AND c.type = 'ticket' AND ct.email = ?2 AND c.created_at > ?3) AS sender,
            (SELECT COUNT(*) FROM conversations WHERE workspace_id = ?1 AND type = 'ticket' AND created_at > ?4) AS day`,
  )
    .bind(workspaceId, from, now - 3_600_000, now - 86_400_000)
    .first<{ sender: number; day: number }>();
  if (counts && (counts.sender >= MAX_TICKETS_PER_SENDER_HOUR || counts.day >= MAX_TICKETS_PER_DAY)) {
    return console.warn(`email ticket over the limit for workspace ${workspaceId}`);
  }

  const subject = ticketSubject(parsed.subject);
  // A reply to mail we never saw: its quote is history, not the question.
  const body = ((replyTo.length ? replyText(text) : text.trim()) || subject).slice(0, MAX_MESSAGE_LENGTH);
  const contactId = await emailContact(env.DB, workspaceId, from, parsed.from?.name ?? "");
  const conversationId = newId("cv");
  const handling = (await loadAiSettings(env, workspaceId)).enabled ? "ai" : "human";
  await env.DB.prepare(
    `INSERT INTO conversations (id, workspace_id, inbox_id, contact_id, type, subject, handling, email_token, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ticket', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(conversationId, workspaceId, inbox.id, contactId, subject, handling, newReplyToken(), now, now, now)
    .run();
  await recordMessageIds(env.DB, workspaceId, conversationId, own);
  const attachments = await storeAttachments(env, workspaceId, contactId, parsed.attachments);
  const ref = { conversationId, workspaceId };
  const stub = env.CONVERSATION.getByName(conversationId);
  await stub.receiveEmail(ref, contactId, { clientMsgId, messageId, from, fromCustomer: true, body, attachments });
  const others = [...(parsed.to ?? []), ...(parsed.cc ?? [])]
    .map((a) => a.address?.toLowerCase() ?? "")
    .filter((a) => a && isEmail(a) && !sameMailbox(a, from) && !parseForwardAddress(a) && !sameMailbox(a, settings.from));
  if (others.length) await stub.addNote(ref, `Also sent to: ${[...new Set(others)].slice(0, 20).join(", ")}. Replies go only to ${from}.`, `email-cc:${clientMsgId}`);
  if (handling === "human") await stub.assignIfNeeded(ref);
}

/**
 * The contact an email sender talks as: the one made for their address before, else a new one.
 * Only `source = 'email'` contacts are reused: a widget visitor who typed the same address may not
 * be them, and this one must never see their chats. V-18 shows them as one person on the desk only.
 */
async function emailContact(db: D1Database, workspaceId: string, email: string, name: string): Promise<string> {
  const found = await db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND email = ? AND source = 'email' ORDER BY created_at LIMIT 1")
    .bind(workspaceId, email)
    .first<{ id: string }>();
  const now = Date.now();
  if (found) {
    await db.prepare("UPDATE contacts SET last_seen_at = ? WHERE id = ?").bind(now, found.id).run();
    return found.id;
  }
  const id = newId("ct");
  const clean = name.replace(/[\r\n<>"]/g, " ").trim().slice(0, 120) || null;
  await db.prepare("INSERT INTO contacts (id, workspace_id, name, email, source, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'email', ?, ?)")
    .bind(id, workspaceId, clean, email, now, now)
    .run();
  await linkPerson(db, workspaceId, id);
  return id;
}

/** An email's files (not the pictures inside an HTML body), stored like a widget upload by the customer. */
async function storeAttachments(env: Env, workspaceId: string, contactId: string, files: { filename: string | null; mimeType: string; disposition: string | null; related?: boolean; content: ArrayBuffer | Uint8Array | string }[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const file of files) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (file.related || (file.disposition === "inline" && file.mimeType.startsWith("image/") && !file.filename)) continue;
    const content = typeof file.content === "string" ? new TextEncoder().encode(file.content) : new Uint8Array(file.content);
    if (!content.byteLength || content.byteLength > MAX_UPLOAD_BYTES) continue;
    const name = (file.filename ?? "file").replace(/[\\/\r\n"]/g, "_").slice(0, 200) || "file";
    const type = file.mimeType.split(";")[0]!.trim().toLowerCase().slice(0, 100) || "application/octet-stream";
    const key = `f_${randomToken(18)}`;
    await env.FILES.put(key, content, { httpMetadata: { contentType: type } });
    await env.DB.prepare("INSERT INTO files (key, workspace_id, name, type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(key, workspaceId, name, type, content.byteLength, `contact:${contactId}`, Date.now())
      .run();
    out.push({ key, name, type, size: content.byteLength });
  }
  return out;
}
