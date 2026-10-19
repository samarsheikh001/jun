import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { contactLabel } from "../../shared/notifications.ts";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { BotIcon, ChatIcon, ContactsIcon, EditIcon, FileIcon, TagIcon } from "../components/icons.tsx";
import {
  commandQuery,
  filterMentions,
  insertMention,
  KIND_LABELS,
  matchCommands,
  MENTION_TOKEN,
  mentionQuery,
  type AskCommand,
  type MentionKind,
  type MentionOption,
} from "../lib/ask-mentions.ts";

// D-134, after beautifului.dev's Prompt Bar (patterns only): "@" opens a list of chats, people, topics
// and agent files and writes a reference the model reads (`@chat:cv_1 (Hana Kim)`), highlighted like
// the Agent page's @mentions (MentionText.tsx: the text drawn again behind a transparent textarea, so
// typing, undo and IME stay the browser's own); "/" at the start lists commands. Arrows move, Enter or
// Tab picks, Escape closes; the list sits above the bar, an inline listbox (a menu would take focus).

type Picked = { kind: "mention"; option: MentionOption } | { kind: "command"; command: AskCommand };

/** Chats, topics and files load once per workspace (a minute); people are searched as typed. */
const cache = new Map<string, { at: number; options: Promise<MentionOption[]> }>();
function baseOptions(ws: string): Promise<MentionOption[]> {
  const hit = cache.get(ws);
  if (hit && Date.now() - hit.at < 60_000) return hit.options;
  const options = Promise.all([
    api<{ conversations: ConversationSummary[] }>(`/workspaces/${ws}/conversations?status=all`).then(
      (r) => r.conversations.map((c): MentionOption => ({ kind: "chat", id: c.id, label: contactLabel(c.contact), detail: [c.status, c.lastMessagePreview].filter(Boolean).join(" · ") })),
      () => [],
    ),
    api<{ topics: { id: string; name: string; conversations: number }[] }>(`/workspaces/${ws}/topics`).then(
      (r) => r.topics.map((t): MentionOption => ({ kind: "topic", id: t.id, label: t.name, detail: `${t.conversations} chat${t.conversations === 1 ? "" : "s"}` })),
      () => [],
    ),
    api<{ files: Record<string, string> }>(`/workspaces/${ws}/agent`).then(
      (r) => Object.keys(r.files).sort().map((path): MentionOption => ({ kind: "file", id: path, label: path })),
      () => [],
    ),
  ]).then((lists) => lists.flat());
  cache.set(ws, { at: Date.now(), options });
  return options;
}

function usePeople(ws: string, query: string | null): MentionOption[] {
  const [people, setPeople] = useState<MentionOption[]>([]);
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const t = setTimeout(() => {
      api<{ people: { id: string; name: string | null; email: string | null; company: { name: string } | null }[] }>(`/workspaces/${ws}/people${query ? `?q=${encodeURIComponent(query)}` : ""}`).then(
        (r) => live && setPeople(r.people.map((p) => ({ kind: "contact", id: p.id, label: contactLabel(p), detail: [p.email !== p.name ? p.email : null, p.company?.name].filter(Boolean).join(" · ") }))),
        () => live && setPeople([]),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ws, query]);
  return people;
}

const KIND_ICONS: Record<MentionKind, () => ReactNode> = { chat: () => <ChatIcon />, contact: () => <ContactsIcon />, topic: () => <TagIcon />, file: () => <FileIcon /> };

/** A question with its @ references highlighted (the box and the thread's own bubbles). */
export function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={m.index} className="ask-mention">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export interface AskInputHandle {
  focus: () => void;
}

export const AskInput = forwardRef<AskInputHandle, {
  ws: string;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onNewChat: () => void;
  disabled: boolean;
  placeholder: string;
}>(function AskInput({ ws, value, onChange, onSend, onNewChat, disabled, placeholder }, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  const back = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<string | null>(null);
  const [base, setBase] = useState<MentionOption[]>([]);

  const command = commandQuery(value);
  const query = command === null && caret !== null ? mentionQuery(value.slice(0, caret)) : null;
  // Escape closes the list until what's typed changes.
  const key = command !== null ? `/${command}` : query !== null ? `@${caret}:${query}` : null;
  const shut = key !== null && key === closed;
  useEffect(() => {
    if (query !== null) void baseOptions(ws).then(setBase);
  }, [ws, query !== null]);
  const people = usePeople(ws, query);
  const items: Picked[] = useMemo(() => {
    if (shut || disabled) return [];
    if (command !== null) return matchCommands(command).map((c) => ({ kind: "command", command: c }));
    if (query === null) return [];
    return filterMentions([...base, ...people], query, query ? 4 : 3).map((o) => ({ kind: "mention", option: o }));
  }, [command, query, base, people, shut, disabled]);
  const open = items.length > 0;
  const pick = active < items.length ? active : 0;
  useEffect(() => setActive(0), [key]);

  const choose = (item: Picked) => {
    if (item.kind === "command") {
      onChange("");
      if (item.command.question) onSend(item.command.question);
      else onNewChat();
      return;
    }
    const el = input.current;
    if (!el || caret === null || query === null) return;
    const next = insertMention(value, caret, query, item.option);
    onChange(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((pick + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(items[pick]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setClosed(key);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend(value);
    }
  };
  const track = () => {
    const el = input.current;
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  let group: string | null = null;
  return (
    <div className="ask-input">
      <div className="ask-input-back" ref={back} aria-hidden="true">
        {highlight(value)}
        {"\n"}
      </div>
      <textarea
        ref={input}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Ask the desk assistant"
        maxLength={2000}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? "ask-menu" : undefined}
        aria-activedescendant={open ? `ask-opt-${pick}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart === e.target.selectionEnd ? e.target.selectionStart : null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && track()}
        onClick={track}
        onBlur={() => setCaret(null)}
        onScroll={(e) => {
          if (back.current) back.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
      {open && (
        <ul className="ask-menu" id="ask-menu" role="listbox" aria-label={command !== null ? "Commands" : "Insert a reference"}>
          {items.map((item, i) => {
            const heading = item.kind === "command" ? "Commands" : KIND_LABELS[item.option.kind];
            const head = heading !== group ? ((group = heading), <li key={`h-${heading}`} role="presentation" className="ask-menu-head">{heading}</li>) : null;
            const icon = item.kind === "command" ? (item.command.question ? <BotIcon /> : <EditIcon />) : KIND_ICONS[item.option.kind]();
            const name = item.kind === "command" ? `/${item.command.name}` : item.option.label;
            const detail = item.kind === "command" ? item.command.description : item.option.detail;
            return [
              head,
              <li
                key={item.kind === "command" ? item.command.name : `${item.option.kind}:${item.option.id}`}
                id={`ask-opt-${i}`}
                role="option"
                aria-selected={i === pick}
                className="ask-menu-option"
                // mousedown, so the textarea keeps its caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="ask-menu-icon" aria-hidden="true">{icon}</span>
                <span className={item.kind === "command" ? "ask-menu-name mono" : "ask-menu-name"}>{name}</span>
                {detail && <span className="ask-menu-detail">{detail}</span>}
              </li>,
            ];
          })}
        </ul>
      )}
    </div>
  );
});
