import PostalMime from "postal-mime";
import {
  emailOn, emailSettings, htmlToText, isAutomatic, MAX_EMAILS_PER_DAY, newReplyToken, parseReplyAddress, renderReplyEmail, replyAddress,
  replyText, sameMailbox, threadHeaders, type EmailSettings,
} from "../../shared/email.ts";
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, MAX_UPLOAD_BYTES, type Attachment, type Message } from "../../shared/protocol.ts";
import type { ConversationRef } from "../conversation.ts";
import { loadMessages } from "./conversations.ts";
import { randomToken, sha256 } from "./crypto.ts";

// C-02 / W-08: the email channel's Worker side. Sending goes through the `send_email` binding (Email
// Sending); replies arrive at the Worker's email() handler (Email Routing). Settings: shared/email.ts.

/** Whether this deploy has the binding at all (an older wrangler.jsonc, or a test, may not). */
export const canSendEmail = (env: Env) => typeof (env as Partial<Env>).EMAIL?.send === "function";

/** The workspace's email settings and the desk's own address (for file links), from the widget inbox. */
export async function loadEmailSettings(db: D1Database, workspaceId: string): Promise<{ inboxId: string; settings: EmailSettings; deskUrl: string | null } | null> {
  const row = await db.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>();
  if (!row) return null;
  const all = JSON.parse(row.settings) as { email?: unknown; emailDeskUrl?: unknown };
  return { inboxId: row.id, settings: emailSettings(all.email), deskUrl: typeof all.emailDeskUrl === "string" ? all.emailDeskUrl : null };
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
    `SELECT c.email_token, c.visitor_read_seq, ct.email, w.name AS workspace_name
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`,
  )
    .bind(ref.conversationId)
    .first<{ email_token: string | null; visitor_read_seq: number; email: string | null; workspace_name: string }>();
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
