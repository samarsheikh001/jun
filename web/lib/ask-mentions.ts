// D-134: the assistant's prompt bar. "@" inserts a reference to a chat, a person, a topic or an agent
// file as plain text the model reads (`@chat:cv_123 (Hana Kim)`), highlighted in the box; "/" at the
// start runs a command (a question, or New chat). Pure parts here; web/home/AskInput.tsx draws them.

export type MentionKind = "chat" | "contact" | "topic" | "file";

export interface MentionOption {
  kind: MentionKind;
  id: string;
  label: string;
  /** A second line: the chat's status and preview, the person's email, the topic's chats. */
  detail?: string;
}

/** A reference as written into the question: `@chat:cv_1 (Hana Kim)`, `@file:tasks/refunds.md`. */
export function mentionToken(o: MentionOption): string {
  if (o.kind === "file") return `@file:${o.id}`;
  const name = o.label.replace(/[()\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `@${o.kind}:${o.id}${name ? ` (${name})` : ""}`;
}

/** Every reference in a text (for the highlight). */
export const MENTION_TOKEN = /(?<![\w.@])@(?:chat|contact|topic|file):[\w./-]*[\w/](?: \([^()\n]{1,80}\))?/g;

/** What's typed after an "@" right before the caret (letters, digits, - _ .), or null. */
export function mentionQuery(before: string): string | null {
  const m = /(?<![\w.@])@([\p{L}\p{N}_.-]*)$/u.exec(before);
  return m ? m[1]! : null;
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Options whose label, id or detail has `query`, label matches first; at most `max` of each kind, in `KINDS` order. */
export function filterMentions(options: MentionOption[], query: string, max = 4): MentionOption[] {
  const q = fold(query.trim());
  const scored = options
    .map((o, i) => {
      const label = fold(o.label);
      const rank = !q ? 1 : label.startsWith(q) ? 0 : label.split(/[\s@._-]+/).some((w) => w.startsWith(q)) ? 1 : label.includes(q) || fold(o.id).includes(q) ? 2 : o.detail && fold(o.detail).includes(q) ? 3 : -1;
      return { o, i, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => KINDS.indexOf(a.o.kind) - KINDS.indexOf(b.o.kind) || a.rank - b.rank || a.i - b.i);
  const seen = new Set<string>();
  const count: Partial<Record<MentionKind, number>> = {};
  const out: MentionOption[] = [];
  for (const { o } of scored) {
    const key = `${o.kind}:${o.id}`;
    if (seen.has(key) || (count[o.kind] ?? 0) >= max) continue;
    seen.add(key);
    count[o.kind] = (count[o.kind] ?? 0) + 1;
    out.push(o);
  }
  return out;
}

export const KINDS: MentionKind[] = ["chat", "contact", "topic", "file"];
export const KIND_LABELS: Record<MentionKind, string> = { chat: "Chats", contact: "People", topic: "Topics", file: "Agent files" };

/** `text` with the "@query" before `caret` replaced by the option's token and a space; the new caret. */
export function insertMention(text: string, caret: number, query: string, o: MentionOption): { text: string; caret: number } {
  const start = caret - query.length - 1;
  const after = text.slice(caret);
  const token = mentionToken(o);
  const space = /^\s/.test(after) ? "" : " ";
  return { text: `${text.slice(0, start)}${token}${space}${after}`, caret: start + token.length + 1 };
}

// ---------- / commands ----------

export interface AskCommand {
  name: string;
  description: string;
  /** The question it asks; none for an action (New chat). */
  question?: string;
}

export const ASK_COMMANDS: AskCommand[] = [
  { name: "brief", description: "Summarise today", question: "Summarise today for me: what happened since yesterday, what needs me now and what's unusual." },
  { name: "unassigned", description: "Chats with the team that nobody has", question: "Which chats with the team have nobody assigned? List them with how long each has waited." },
  { name: "errors", description: "Browser errors in chats this week", question: "Which chats in the last 7 days had browser errors or failed requests, and what were the errors?" },
  { name: "knowledge-gaps", description: "What the AI couldn't answer", question: "Which questions couldn't the AI answer from the knowledge this week, and what should I add first?" },
  { name: "new", description: "Start a new chat" },
];

/** A "/command" being typed as the whole message so far, or null. */
export function commandQuery(text: string): string | null {
  const m = /^\/([a-z-]*)$/.exec(text);
  return m ? m[1]! : null;
}

/** Commands starting with what's typed first, then (from two letters) those that have it. */
export const matchCommands = (query: string): AskCommand[] => [
  ...ASK_COMMANDS.filter((c) => c.name.startsWith(query)),
  ...ASK_COMMANDS.filter((c) => !c.name.startsWith(query) && query.length > 1 && c.name.includes(query)),
];
