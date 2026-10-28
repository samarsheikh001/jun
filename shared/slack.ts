// C-09 / T-13 (D-152): team replies from Slack. Pure parts shared by the Worker and the desk: the app
// manifest the setup link opens, text in and out of Slack's mrkdwn, the card at the top of a chat's
// thread, the modal for an internal note, and what the desk shows about a connection.
// Research and the rules followed: docs/research/09-slack.md.

/** 'handoff': a thread when a chat starts needing a person (D-13's default); 'all': for every new chat. */
export type SlackMode = "handoff" | "all";
export const SLACK_MODES: SlackMode[] = ["handoff", "all"];

/** Interactive ids (the manifest's shortcut, the card's buttons, the note modal). */
export const SLACK_IDS = {
  noteShortcut: "jun_note",
  noteModal: "jun_note_modal",
  noteBlock: "note",
  noteInput: "text",
  assign: "jun_assign",
  close: "jun_close",
  reopen: "jun_reopen",
  open: "jun_open",
} as const;

/** The bot's scopes: post (with a teammate's or the visitor's name), read thread replies, join a public channel, read who wrote. `commands`: Slack refuses a manifest with a shortcut (the note) without it. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "commands",
  "chat:write.customize",
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  "channels:join",
  "users:read",
  "users:read.email",
] as const;

export const slackEventsUrl = (origin: string, workspaceId: string) => `${origin}/api/slack/${workspaceId}/events`;
export const slackActionsUrl = (origin: string, workspaceId: string) => `${origin}/api/slack/${workspaceId}/actions`;

/**
 * The Slack app for one workspace, in Slack's manifest format: Slack's "create app" page opens with it
 * filled in (`slackManifestUrl`). Each company makes its own app (internal apps keep the full rate limits).
 */
export function slackManifest(origin: string, workspaceId: string, workspaceName: string): Record<string, unknown> {
  const name = `${workspaceName.trim() || "Jun"} support`.slice(0, 35);
  return {
    display_information: {
      name,
      description: "Chats from your Jun desk: reply in a thread to answer the customer.",
      background_color: "#1f1a13",
    },
    features: {
      bot_user: { display_name: "Jun", always_online: true },
      shortcuts: [
        {
          name: "Add internal note",
          type: "message",
          callback_id: SLACK_IDS.noteShortcut,
          description: "A note in this chat that the customer never sees",
        },
      ],
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: slackEventsUrl(origin, workspaceId), bot_events: ["message.channels", "message.groups"] },
      interactivity: { is_enabled: true, request_url: slackActionsUrl(origin, workspaceId) },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export const slackManifestUrl = (manifest: Record<string, unknown>) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

/** What an admin pastes after installing the app. Throws with a sentence to show. */
export function readSlackKeys(body: Record<string, unknown>): { token: string; signingSecret: string } {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const signingSecret = typeof body.signingSecret === "string" ? body.signingSecret.trim() : "";
  if (!/^xoxb-[\w-]{10,250}$/.test(token)) throw new Error("The Bot User OAuth Token starts with xoxb-. It's under OAuth & Permissions after you install the app.");
  if (!/^[0-9a-f]{32}$/i.test(signingSecret)) throw new Error("The Signing Secret is 32 letters and numbers, under Basic Information → App Credentials.");
  return { token, signingSecret };
}

/** GET /workspaces/:id/slack. */
export interface SlackView {
  connected: boolean;
  teamName: string | null;
  teamUrl: string | null;
  channel: { id: string; name: string } | null;
  mode: SlackMode;
  status: "connected" | "broken" | null;
  lastError: string | null;
  /** Admins only. */
  tokenLast4: string | null;
  manifestUrl: string;
  eventsUrl: string;
  /** Slack can't reach a desk on 127.0.0.1 / localhost. */
  local: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  /** The bot is in it (a private channel must invite it first). */
  member: boolean;
}

// ---------- text ----------

/** Our text as Slack mrkdwn: only &, < and > are special (Slack's escaping rules). */
export function toSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A Slack message's text as plain text for the customer: links `<url|label>` → "label (url)",
 * mentions `<@U…>` → @name (from `names`, else dropped), channels `<#C…|name>` → #name,
 * `<!here>` and friends dropped, entities decoded.
 */
export function fromSlackText(text: string, names: Record<string, string> = {}): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => (names[id] ?? label ? `@${names[id] ?? label}` : ""))
    .replace(/<#[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => (name ? `#${name}` : ""))
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/g, "")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => name ?? "")
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<(mailto:)?([^|>]+)\|([^>]+)>/g, (_, mail: string | undefined, url: string, label: string) => (label === url || mail ? label : `${label} (${url})`))
    .replace(/<([^>]+)>/g, (_, url: string) => url.replace(/^mailto:/, ""))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Keep under Slack's advice for `text` (4,000), leaving room for the name and marks we add. */
export function clip(text: string, max = 3500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One message in the thread: who wrote it (as `username`) and the text. */
export interface ThreadLine {
  authorType: "visitor" | "ai" | "agent";
  author: string;
  body: string;
  attachments: { name: string }[];
  internal: boolean;
}

export function threadText(line: ThreadLine): string {
  const files = line.attachments.map((a) => `📎 ${toSlackText(a.name)}`).join("\n");
  const body = [toSlackText(line.body), files].filter(Boolean).join("\n");
  return clip(line.internal ? `🔒 *Note* (only the team sees this)\n${body}` : body);
}

/** The name a thread message shows (chat:write.customize). Slack caps it at 80. */
export function threadUsername(line: Pick<ThreadLine, "authorType" | "author">): string {
  const who = line.authorType === "visitor" ? `${line.author} (customer)` : line.authorType === "ai" ? `${line.author} (AI)` : line.author;
  return who.slice(0, 80);
}

/** The messages before the thread opened, as one quoted message (newest last, at most `max`). */
export function backfillText(lines: ThreadLine[], max = 12): string | null {
  const recent = lines.filter((l) => !l.internal).slice(-max);
  if (!recent.length) return null;
  const skipped = lines.filter((l) => !l.internal).length - recent.length;
  const quoted = recent.map((l) => {
    const who = l.authorType === "visitor" ? l.author : l.authorType === "ai" ? "AI" : l.author;
    const text = clip(l.body.replace(/\s+/g, " ").trim(), 400) || (l.attachments.length ? "📎 a file" : "");
    return `> *${toSlackText(who)}:* ${toSlackText(text)}`;
  });
  return clip(`${skipped > 0 ? `_${skipped} earlier messages in the desk_\n` : ""}*Earlier in this chat*\n${quoted.join("\n")}`, 3900);
}

// ---------- the card at the top of a thread ----------

export interface CardFacts {
  conversationId: string;
  contact: string;
  contactEmail: string | null;
  status: "open" | "pending" | "resolved" | "snoozed";
  handling: "ai" | "human";
  assignee: string | null;
  /** Why it needs a person (the handoff reason), if it was handed off. */
  reason: string | null;
  /** The AI's handoff brief, if there was one. */
  brief: string | null;
  /** From the latest debug snapshot: page path, browser, errors. */
  page: string | null;
  browser: string | null;
  issues: number;
  deskUrl: string;
}

/** The card's state line: what the buttons and Slack's preview reflect. */
export function cardState(f: Pick<CardFacts, "status" | "handling" | "assignee">): string {
  if (f.status === "resolved") return "✅ Closed";
  if (f.status === "snoozed") return "💤 Snoozed";
  if (f.handling === "ai") return "🤖 With the AI";
  return f.assignee ? `👤 ${f.assignee} has it` : "🟠 Waiting for the team";
}

/** A short browser name from a user agent ("Chrome on macOS"). */
export function browserName(ua: string): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (!browser && !os) return null;
  return [browser, os].filter(Boolean).join(" on ");
}

/** Block Kit for the card. `key` changes when anything shown changes (so the card is updated only then). */
export function cardBlocks(f: CardFacts): { text: string; blocks: unknown[]; key: string } {
  const state = cardState(f);
  const who = f.contactEmail && f.contactEmail !== f.contact ? `${f.contact} · ${f.contactEmail}` : f.contact;
  const facts = [f.page ? `Page \`${f.page.slice(0, 120)}\`` : null, f.browser, f.issues ? `${f.issues} error${f.issues === 1 ? "" : "s"} in the browser` : null].filter(Boolean);
  const buttons: unknown[] = [];
  if (f.status !== "resolved") {
    buttons.push({ type: "button", action_id: SLACK_IDS.assign, text: { type: "plain_text", text: "Assign to me" }, value: f.conversationId });
    buttons.push({ type: "button", action_id: SLACK_IDS.close, text: { type: "plain_text", text: "Close" }, value: f.conversationId });
  } else {
    buttons.push({ type: "button", action_id: SLACK_IDS.reopen, text: { type: "plain_text", text: "Reopen" }, value: f.conversationId });
  }
  buttons.push({ type: "button", action_id: SLACK_IDS.open, text: { type: "plain_text", text: "Open in desk" }, url: f.deskUrl });
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${toSlackText(who.slice(0, 200))}*\n${state}` } },
  ];
  if (f.reason) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Why:* ${toSlackText(f.reason)}`, 2900) } });
  if (f.brief) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(toSlackText(f.brief), 2900) } });
  if (facts.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(facts.map((x) => toSlackText(String(x))).join(" · "), 2900) }] });
  blocks.push({ type: "actions", elements: buttons });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Reply in this thread to answer the customer. To write something only the team sees, use ⋯ on a message → *Add internal note*." }],
  });
  const text = clip(`${who}: ${state}`, 300);
  const key = JSON.stringify([who, state, f.reason, f.brief, facts]);
  return { text, blocks, key };
}

// ---------- the internal-note modal ----------

export function noteModal(conversationId: string, contact: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: SLACK_IDS.noteModal,
    private_metadata: JSON.stringify({ c: conversationId }),
    title: { type: "plain_text", text: "Internal note" },
    submit: { type: "plain_text", text: "Save note" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: SLACK_IDS.noteBlock,
        label: { type: "plain_text", text: `In the chat with ${contact}`.slice(0, 150) },
        element: { type: "plain_text_input", action_id: SLACK_IDS.noteInput, multiline: true, max_length: 3000 },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Only your team sees it: in the desk and in this thread. The customer never does." }] },
    ],
  };
}
