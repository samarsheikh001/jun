// C-02 / W-08: the email channel (two-way replies), pure. The desk emails a teammate's (or the AI's)
// replies to a customer who has left the chat; the customer's reply to that email comes back into the
// same conversation. Off until an admin sets it up (Channels → Email): a fresh install sends nothing.

/** A workspace's email settings, kept in the widget inbox's settings as `email`. */
export interface EmailSettings {
  enabled: boolean;
  /** The address replies come from, on a domain onboarded to Cloudflare Email Sending. */
  from: string;
  /** Shown as the sender's name; empty = the workspace's name. */
  fromName: string;
  /**
   * The domain (often a subdomain, e.g. reply.acme.com) whose mail Email Routing hands to this Worker:
   * each conversation gets its own address there, so a reply finds its chat.
   */
  replyDomain: string;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = { enabled: false, from: "", fromName: "", replyDomain: "" };

/** Wait this long after the newest reply the customer hasn't seen, then email it (more replies join it). */
export const EMAIL_DELAY_MS = 2 * 60 * 1000;
/** At most this many emails a day per conversation. */
export const MAX_EMAILS_PER_DAY = 20;
/** At most this many emails in from a customer per conversation per hour (the rest are dropped). */
export const MAX_INBOUND_PER_HOUR = 30;
/** Above the quoted history in every email we send, so a reply cuts cleanly at it. */
export const REPLY_MARKER = "—— Reply above this line ——";

const EMAIL_RE = /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isEmail = (value: string) => value.length <= 320 && EMAIL_RE.test(value);
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Lenient: whatever is stored, as settings (bad or missing fields → defaults). */
export function emailSettings(raw: unknown): EmailSettings {
  const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  return { enabled: v.enabled === true, from: str(v.from), fromName: str(v.fromName), replyDomain: str(v.replyDomain) };
}

/**
 * Strict: an admin's change applied to the current settings. Throws an Error with a message for the
 * admin on the first bad field. Turning email on needs a from address and a reply domain.
 */
export function applyEmailPatch(current: EmailSettings, body: Record<string, unknown>): EmailSettings {
  const next = { ...current };
  if (body.from !== undefined) {
    if (typeof body.from !== "string") throw new Error("The from address must be text.");
    const from = body.from.trim().toLowerCase();
    if (from && !isEmail(from)) throw new Error("The from address doesn't look like an email address (e.g. support@acme.com).");
    next.from = from;
  }
  if (body.fromName !== undefined) {
    if (typeof body.fromName !== "string") throw new Error("The sender name must be text.");
    const name = body.fromName.replace(/[\r\n"<>]/g, " ").trim();
    if (name.length > 80) throw new Error("The sender name is limited to 80 characters.");
    next.fromName = name;
  }
  if (body.replyDomain !== undefined) {
    if (typeof body.replyDomain !== "string") throw new Error("The reply domain must be text.");
    const domain = body.replyDomain.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
    if (domain && !DOMAIN_RE.test(domain)) throw new Error("The reply domain doesn't look like a domain (e.g. reply.acme.com).");
    next.replyDomain = domain;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("Email replies must be on or off.");
    next.enabled = body.enabled;
  }
  if (next.enabled) {
    if (!next.from) throw new Error("Add the address replies come from first.");
    if (!next.replyDomain) throw new Error("Add the domain customers' replies go to first.");
  }
  return next;
}

/** What's missing before email can work, for the Channels page; empty when it's ready. */
export function emailProblems(settings: EmailSettings, canSend: boolean): string[] {
  const problems: string[] = [];
  if (!canSend) problems.push("This desk has no send_email binding, so it can't send email. Redeploy with the latest wrangler.jsonc.");
  if (!settings.from) problems.push("No from address.");
  if (!settings.replyDomain) problems.push("No reply domain.");
  return problems;
}

/** Is email set up and on (the widget then promises a reply by email)? */
export const emailOn = (settings: EmailSettings, canSend: boolean) => settings.enabled && emailProblems(settings, canSend).length === 0;

// ---------- reply addresses ----------

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 24;
/**
 * The local part replies go to: `reply+<token>@domain`. Email Routing's subaddressing sends every
 * `reply+…` address to one literal rule for `reply@`, which works on a subdomain too (a catch-all
 * only covers a zone's apex, and would take over the owner's own catch-all).
 */
export const REPLY_LOCAL = "reply";
const TOKEN_RE = new RegExp(`^${REPLY_LOCAL}\\+([a-z0-9]{${TOKEN_LENGTH}})$`);
/** The first addresses given out (`c-<token>@`, before D-111): still accepted. */
const OLD_TOKEN_RE = new RegExp(`^c-([a-z0-9]{${TOKEN_LENGTH}})$`);

/** A conversation's reply token: 24 of [a-z0-9] (~124 bits), safe in an address's local part. */
export function newReplyToken(): string {
  // 36 doesn't divide 256: skip bytes ≥ 252 so every character is equally likely.
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH))) {
      if (b < 252 && out.length < TOKEN_LENGTH) out += TOKEN_ALPHABET[b % 36];
    }
  }
  return out;
}

export const replyAddress = (token: string, replyDomain: string) => `${REPLY_LOCAL}+${token}@${replyDomain}`;

/** The address the routing rule matches (every reply address is a subaddress of it). */
export const replyRuleAddress = (replyDomain: string) => `${REPLY_LOCAL}@${replyDomain}`;

/** The token and domain in an address we gave out (`reply+<token>@domain`, or an old `c-<token>@domain` with an optional `+tag`), else null. */
export function parseReplyAddress(address: string): { token: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const local = address.slice(0, at).toLowerCase();
  const match = TOKEN_RE.exec(local) ?? OLD_TOKEN_RE.exec(local.replace(/\+.*$/, ""));
  return match ? { token: match[1]!, domain: domainOf(address) } : null;
}

// ---------- a forwarded support inbox (C-13) ----------

/**
 * C-13: the address a support inbox forwards to, `reply+in-<token>@<reply domain>`. It's a subaddress
 * of the same `reply@` rule, so it needs no Cloudflare setup of its own; the token is the workspace's
 * own (random, changed on the Channels page), so nobody mails the desk directly without going through
 * support@.
 */
const FORWARD_RE = new RegExp(`^${REPLY_LOCAL}\\+in-([a-z0-9]{${TOKEN_LENGTH}})$`);

export const forwardAddress = (token: string, replyDomain: string) => `${REPLY_LOCAL}+in-${token}@${replyDomain}`;

export function parseForwardAddress(address: string): { token: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const match = FORWARD_RE.exec(address.slice(0, at).toLowerCase());
  return match ? { token: match[1]!, domain: domainOf(address) } : null;
}

/** What's kept in the widget inbox's settings as `emailForwarding`. */
export interface ForwardingSettings {
  enabled: boolean;
  token: string;
  /** When the last forwarded email arrived (the page's "Receiving" line). */
  lastAt: number | null;
  /** A Gmail forwarding confirmation that came in, for the admin to copy (Gmail asks before it forwards). */
  confirmation: { code: string; link: string | null; at: number } | null;
}

export function forwardingSettings(raw: unknown): ForwardingSettings {
  const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const c = typeof v.confirmation === "object" && v.confirmation !== null ? (v.confirmation as Record<string, unknown>) : null;
  return {
    enabled: v.enabled === true,
    token: typeof v.token === "string" ? v.token : "",
    lastAt: typeof v.lastAt === "number" ? v.lastAt : null,
    confirmation: c && typeof c.code === "string" && typeof c.at === "number" ? { code: c.code, link: typeof c.link === "string" ? c.link : null, at: c.at } : null,
  };
}

/** New tickets at most this often: per sender per hour, and per workspace per day. Over it, mail is kept closed and unanswered. */
export const MAX_TICKETS_PER_SENDER_HOUR = 10;
export const MAX_TICKETS_PER_DAY = 300;

/**
 * Gmail's "Forwarding Confirmation" mail (sent to the forwarding address before Gmail forwards
 * anything): its code and link, else null. Never a ticket.
 */
export function gmailConfirmation(from: string, subject: string, text: string): { code: string; link: string | null } | null {
  if (!/@google\.com$/i.test(from.trim()) || !/forwarding confirmation/i.test(subject)) return null;
  const code = /\(#(\d{5,})\)/.exec(subject)?.[1] ?? /confirmation code:\s*(\d{5,})/i.exec(text)?.[1];
  if (!code) return null;
  const link = /https:\/\/mail(?:-settings)?\.google\.com\/mail\/\S+/i.exec(text)?.[0] ?? null;
  return { code, link: link?.replace(/[>)\].,]+$/, "") ?? null };
}

/** Message-IDs as a list: one header's ids (`<a@b> <c@d>`), without the brackets. */
export function messageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const bracketed = header.match(/<[^<>\s]+>/g);
  const ids = bracketed ? bracketed.map((id) => id.slice(1, -1)) : header.split(/\s+/);
  return ids.map((id) => id.trim()).filter((id) => id.length > 2 && id.length <= 500);
}

/** The subject a ticket keeps: no "Re:"/"Fwd:" prefixes, one line, ≤ 200 characters. */
export function ticketSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  while (/^(re|fwd?|aw|wg|sv|tr)\s*(\[\d+\])?\s*:\s*/i.test(s)) s = s.replace(/^(re|fwd?|aw|wg|sv|tr)\s*(\[\d+\])?\s*:\s*/i, "");
  return s.slice(0, 200) || "(no subject)";
}

/** A blocked sender, as stored: the address (no +tag), or `@domain` for the whole domain. */
export function blockPattern(address: string, scope: "address" | "domain"): string {
  const v = address.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  return scope === "domain" ? v.slice(at) : `${v.slice(0, at).replace(/\+.*$/, "")}${v.slice(at)}`;
}

export function isBlocked(address: string, patterns: string[]): boolean {
  const mine = blockPattern(address, "address");
  const domain = blockPattern(address, "domain");
  return patterns.some((p) => p === mine || p === domain);
}

/** Same mailbox, ignoring case and a `+tag` (people reply from user+support@…). */
export function sameMailbox(a: string, b: string): boolean {
  const norm = (x: string) => {
    const v = x.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
    const at = v.lastIndexOf("@");
    return at < 1 ? v : `${v.slice(0, at).replace(/\+.*$/, "")}@${v.slice(at + 1)}`;
  };
  return norm(a) === norm(b);
}

// ---------- inbound ----------

/**
 * Mail that no person wrote (out-of-office, bounces, mailing lists, our own echoes): never a message
 * in the chat, so two autoresponders can't loop. `get` reads a header by name (case-insensitive).
 * `forwarded`: mail a support inbox forwarded (C-13), which a forwarding rule may mark `auto-forwarded`
 * (RFC 3834) though a person wrote it.
 */
export function isAutomatic(get: (name: string) => string | null, from: string, options: { forwarded?: boolean } = {}): boolean {
  const auto = get("auto-submitted")?.trim().toLowerCase();
  if (auto && auto !== "no" && !(options.forwarded && auto.startsWith("auto-forwarded"))) return true;
  if (get("x-autoreply") || get("x-autorespond") || get("x-auto-response-suppress")?.match(/\b(all|oof|autoreply)\b/i)) return true;
  if (get("list-id") || get("list-unsubscribe")) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(get("precedence")?.trim() ?? "")) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from.trim())) return true;
  if (get("x-jun-desk")) return true;
  return false;
}

/** Quoted history starts at the first of these lines (Gmail, Apple Mail, Outlook, Thunderbird, ours). */
const QUOTE_HEADERS = [
  /^—— Reply above this line ——/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^_{10,}\s*$/, // Outlook's rule above "From:"
  /^From:\s.+/i, // Outlook: "From: … Sent: …" (only with "Sent:"/"Date:" close by, checked below)
  /^On\s.+wrote:\s*$/i,
  /^Le\s.+a écrit\s*:\s*$/i,
  /^Am\s.+schrieb.*:\s*$/i,
  /^El\s.+escribió:\s*$/i,
];

/**
 * The new part of a reply: everything above the quoted history and the signature. Falls back to the
 * whole text when cutting would leave nothing (someone who wrote below the quote).
 */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Gmail wraps a long "On …, Name <a@b.c> wrote:" over two lines.
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]!.trim()}` : line;
    const isFrom = /^From:\s/i.test(line);
    if (isFrom) {
      const near = lines.slice(i + 1, i + 5).join("\n");
      if (!/^(Sent|Date|To|Subject):/im.test(near)) continue;
    }
    if (QUOTE_HEADERS.some((re) => re.test(line)) || (/^On\s/i.test(line) && /wrote:\s*$/i.test(joined) && !/wrote:\s*$/i.test(line))) {
      end = i;
      break;
    }
    // A block of "> " lines (the quote itself, with no header we know).
    if (/^>/.test(line) && lines.slice(i).filter((l) => l.trim()).every((l) => /^>/.test(l.trim()))) {
      end = i;
      break;
    }
  }
  let kept = lines.slice(0, end);
  // A signature after "-- " (the standard delimiter), or a phone's "Sent from my …".
  const sig = kept.findIndex((l) => l === "-- " || l.trim() === "--" || /^Sent from my\s/i.test(l.trim()) || /^Get Outlook for /i.test(l.trim()));
  if (sig >= 0) kept = kept.slice(0, sig);
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || text.trim();
}

/** Plain text from an HTML-only email: good enough for a chat message (no markup kept). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*$/i, "") // quoted history in most HTML mail
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- outbound ----------

export interface EmailedMessage {
  author: string;
  body: string;
  /** Links to its attachments (unguessable file URLs). */
  files: { name: string; url: string }[];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One stable subject per conversation, so mail apps keep one thread. */
export const replySubject = (workspaceName: string) => `Re: your conversation with ${workspaceName}`;

/**
 * The email for the replies a customer hasn't seen: plain text and simple HTML. A ticket (C-13)
 * answers under its own subject.
 */
export function renderReplyEmail(input: { workspaceName: string; messages: EmailedMessage[]; subject?: string | null }): { subject: string; text: string; html: string } {
  // The author's name once per run of their messages.
  const named = input.messages.map((m, i) => ({ ...m, showAuthor: i === 0 || input.messages[i - 1]!.author !== m.author }));
  const text = [
    REPLY_MARKER,
    "",
    ...named.flatMap((m) => [
      ...(m.showAuthor ? [m.author] : []),
      m.body,
      ...m.files.map((f) => `${f.name}: ${f.url}`),
      "",
    ]),
    `Reply to this email to answer ${input.workspaceName}.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;background:#ffffff">
<p style="margin:0 0 20px;color:#8a8a8a;font-size:12px">${escapeHtml(REPLY_MARKER)}</p>
${named
  .map(
    (m) => `<div style="margin:0 0 20px">
${m.showAuthor ? `<div style="font-size:13px;color:#6b6b6b;margin:0 0 4px"><strong style="color:#1f1f1f">${escapeHtml(m.author)}</strong></div>` : ""}
<div style="white-space:pre-wrap">${escapeHtml(m.body)}</div>
${m.files.map((f) => `<div style="margin-top:6px"><a href="${escapeHtml(f.url)}" style="color:#2563eb">${escapeHtml(f.name)}</a></div>`).join("")}
</div>`,
  )
  .join("\n")}
<p style="margin:24px 0 0;color:#8a8a8a;font-size:12px">Reply to this email to answer ${escapeHtml(input.workspaceName)}.</p>
</body></html>`;
  return { subject: input.subject ? `Re: ${input.subject}` : replySubject(input.workspaceName), text, html };
}

/** A Message-ID as headers want it: `<id>`. */
export const angle = (id: string) => (id.startsWith("<") ? id : `<${id}>`);

/** Threading headers for the next email: the ids seen so far, newest last (References is capped). */
export function threadHeaders(ids: string[]): Record<string, string> {
  const refs = ids.slice(-10).map(angle);
  if (!refs.length) return {};
  return { "In-Reply-To": refs[refs.length - 1]!, References: refs.join(" ") };
}
