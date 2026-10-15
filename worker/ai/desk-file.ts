import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify, type Document } from "yaml";
import { PAGE_CONTROL_CONFIRMS, pageControlConfirm, type PageControlConfirm } from "../../shared/page-control.ts";
import { APPEARANCE_DEFAULTS, applyAppearance, widgetLook, type ButtonStyle, type IslandSurface, type WidgetMode, type WidgetTheme } from "../../shared/appearance.ts";
import { DEFAULT_AWAY_MESSAGE, parseHours, validTimezone, type BusinessHours, type DayHours, type Weekday } from "../../shared/hours.ts";
import { assignmentSettings, parseAssignment } from "../../shared/inbox.ts";
import { parseOpeners, storedOpeners, type OpenerRule } from "../../shared/openers.ts";
import { applyInboxPatch } from "../lib/inbox-settings.ts";
import { normalizeDomains } from "../lib/origins.ts";
import { InvalidModelsError, MODEL_ID, parseJobModels, type JobModels } from "./models.ts";

// D-84: desk settings as code. `desk.yaml` sits in the agent's folder beside instructions.md and holds the
// desk's settings that are plain choices: the AI's switches, the chat widget, business hours and
// assignment. The stores the app reads stay where they were (`inboxes.settings`, `ai_settings`):
// saving the file applies what changed in it to them, and the settings pages write their changes
// back into the file. A key (or a whole section) left out is left as it is on the desk.
// Pure: parse and check, settings → file, file → settings, edit in place.

export const DESK_PATH = "desk.yaml";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
type DayName = (typeof DAYS)[number];
/** The order days are written in: the working week first. */
const DAY_ORDER: DayName[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface DeskOpener {
  /** Page pattern: /pricing, /docs/*, *. */
  page: string;
  /** Seconds on the page before it shows. */
  after: number;
  /** Fixed text; without it the AI writes the line (from `hint`). */
  message?: string;
  hint?: string;
}

/** desk.yaml as data, in the file's own shape (what `parseDeskFile` returns, and `renderDeskFile` writes). */
export interface DeskFile {
  ai?: {
    enabled?: boolean;
    /** "default": the provider's default model. */
    model?: string;
    /** AI-16: per-job models. */
    models?: JobModels;
    /** AI replies a month; 0 = no limit. */
    monthlyReplyCap?: number;
  };
  chat?: {
    /** "" = the workspace's name. */
    name?: string;
    color?: string;
    /** D-89: island or window (the old `launcher:` key is read too and mapped, see parseChat). */
    mode?: WidgetMode;
    /** Window only: the greeting card over the button. */
    greetingCard?: boolean;
    /** Window only: the round button shows your logo or text. */
    button?: ButtonStyle;
    /** Window only. */
    position?: "left" | "right";
    /** Island only. */
    island?: { surface?: IslandSurface; glow?: boolean };
    theme?: WidgetTheme;
    rounding?: number;
    sound?: boolean;
    greeting?: string;
    replyTime?: string;
    placeholder?: string;
    suggestedQuestions?: string[];
    askForRating?: boolean;
    allowedWebsites?: string[];
    offerHelpOnErrors?: boolean;
    /** AI-32: the AI may read and use your website (page control). */
    pageControl?: boolean;
    /** AI-32: before it clicks, types or chooses: allow-always (ask, with Always allow), every-time, never. */
    pageControlConfirm?: PageControlConfirm;
    openers?: DeskOpener[];
  };
  hours?: {
    enabled?: boolean;
    timeZone?: string;
    /** Open days: monday: "09:00-17:30". Days not listed are closed. */
    days?: Partial<Record<DayName, string>>;
    awayMessage?: string;
  };
  inbox?: {
    assignment?: { mode?: "manual" | "round_robin"; capacity?: number };
  };
}

/** What `ai_settings` holds that desk.yaml covers (the provider and its sign-in aren't in the file). */
export interface DeskAi {
  enabled: boolean;
  model: string | null;
  models: JobModels;
  monthlyReplyCap: number;
}

export interface DeskIssue {
  path: string;
  message: string;
}

// ---------- checks shared with the settings routes ----------

export const MAX_REPLY_CAP = 1_000_000;

/** The monthly AI reply cap (PUT /ai and desk.yaml). Throws a message for the admin. */
export function readReplyCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_REPLY_CAP) throw new Error("The monthly reply cap must be a whole number from 0 (no limit) to 1000000.");
  return value;
}

/** The workspace model: null (or "", "default") = the provider's default. Throws a message for the admin. */
export function readModel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("The model must be a model id, or default.");
  const id = value.trim();
  if (!id || id === "default") return null;
  if (!MODEL_ID.test(id)) throw new Error(`"${id.slice(0, 100)}" isn't a model id (up to 100 letters, digits and . : / @ - _).`);
  return id;
}

// ---------- parsing ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string, issues: DeskIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: DESK_PATH, message: `Unknown key "${where}${key}". Allowed: ${allowed.join(", ")}.` });
  }
}

/** A section's map: null (`hours:` with nothing under it) is an empty one; anything else is a problem. */
function section(data: Record<string, unknown>, key: string, where: string, issues: DeskIssue[]): Record<string, unknown> | null {
  const value = data[key];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    issues.push({ path: DESK_PATH, message: `${where}${key} must be a group of settings: indented key: value lines under it.` });
    return null;
  }
  return value;
}

const bool = (value: unknown) => typeof value === "boolean";

/** chat key → the inbox setting's field (what applyAppearance checks). */
const LOOK_FIELDS = {
  name: "displayName",
  color: "color",
  mode: "mode",
  greetingCard: "greetingCard",
  button: "buttonStyle",
  position: "position",
  theme: "theme",
  rounding: "radius",
  greeting: "greeting",
  replyTime: "replyTime",
  placeholder: "placeholder",
  suggestedQuestions: "suggestions",
} as const;

const TEXT_DEFAULTS = { greeting: APPEARANCE_DEFAULTS.greeting, replyTime: APPEARANCE_DEFAULTS.replyTime, placeholder: APPEARANCE_DEFAULTS.placeholder } as const;

// `launcher` is the pre-D-89 key: still read (island and bar → mode island, card → window with the
// greeting card, button → window without), never written.
const CHAT_KEYS = [...Object.keys(LOOK_FIELDS), "island", "sound", "askForRating", "allowedWebsites", "offerHelpOnErrors", "pageControl", "pageControlConfirm", "openers", "launcher"];

/** applyAppearance's words for its fields → desk.yaml's keys. */
const fieldWords = (message: string) => message.replace(/\bdisplayName\b/, "name");

const TIME_SPAN = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/;

function parseChat(raw: Record<string, unknown>, issues: DeskIssue[]): NonNullable<DeskFile["chat"]> {
  const out: NonNullable<DeskFile["chat"]> = {};
  unknownKeys(raw, CHAT_KEYS, "chat.", issues);
  const problem = (key: string, message: string) => issues.push({ path: DESK_PATH, message: `chat.${key}: ${message}` });
  for (const [key, field] of Object.entries(LOOK_FIELDS)) {
    if (raw[key] === undefined) continue;
    const value = key === "name" && raw[key] === null ? "" : raw[key];
    const scratch: Record<string, unknown> = {};
    try {
      applyAppearance(scratch, { [field]: value });
    } catch (error) {
      problem(key, fieldWords((error as Error).message));
      continue;
    }
    const set = scratch[field];
    // An empty text means the default words: written as those words (what visitors see).
    const fallback = key in TEXT_DEFAULTS ? TEXT_DEFAULTS[key as keyof typeof TEXT_DEFAULTS] : "";
    (out as Record<string, unknown>)[key] = key === "suggestedQuestions" ? (set ?? []) : set === undefined ? fallback : set;
  }
  if (raw.launcher !== undefined) {
    // D-89: an older file's launcher, as the mode and the greeting card switch (mode and greetingCard win).
    const scratch: Record<string, unknown> = {};
    try {
      applyAppearance(scratch, { launcher: raw.launcher });
      out.mode ??= scratch.mode as WidgetMode;
      if (raw.launcher === "card" || raw.launcher === "button") out.greetingCard ??= scratch.greetingCard as boolean;
    } catch {
      problem("launcher", "use mode: island or window instead (launcher is the old key: island, card or button).");
    }
  }
  if (raw.island !== undefined && raw.island !== null) {
    if (!isRecord(raw.island)) problem("island", "use surface: dark or page, and glow: true or false.");
    else {
      unknownKeys(raw.island, ["surface", "glow"], "chat.island.", issues);
      const island: NonNullable<NonNullable<DeskFile["chat"]>["island"]> = {};
      if (raw.island.surface !== undefined) {
        if (raw.island.surface === "dark" || raw.island.surface === "page") island.surface = raw.island.surface;
        else problem("island.surface", "use dark (near-black on every page) or page (follows the theme).");
      }
      if (raw.island.glow !== undefined) {
        if (bool(raw.island.glow)) island.glow = raw.island.glow as boolean;
        else problem("island.glow", "use true or false.");
      }
      out.island = island;
    }
  }
  for (const key of ["sound", "askForRating", "offerHelpOnErrors", "pageControl"] as const) {
    if (raw[key] === undefined) continue;
    if (bool(raw[key])) out[key] = raw[key] as boolean;
    else problem(key, "use true or false.");
  }
  if (raw.pageControlConfirm !== undefined) {
    if (PAGE_CONTROL_CONFIRMS.includes(raw.pageControlConfirm as PageControlConfirm)) out.pageControlConfirm = raw.pageControlConfirm as PageControlConfirm;
    else problem("pageControlConfirm", "use allow-always (ask, with an Always allow button), every-time or never.");
  }
  if (raw.allowedWebsites !== undefined) {
    const list = raw.allowedWebsites === null ? [] : raw.allowedWebsites;
    if (!Array.isArray(list) || list.some((d) => typeof d !== "string")) problem("allowedWebsites", "a list of websites, like [acme.com, \"*.acme.com\"]. An empty list ([]) means any website.");
    else {
      const { domains, invalid } = normalizeDomains(list);
      if (invalid.length) problem("allowedWebsites", `not a website: ${invalid.join(", ")}. Use e.g. acme.com or "*.acme.com".`);
      else out.allowedWebsites = domains;
    }
  }
  if (raw.openers !== undefined) {
    const list = raw.openers === null ? [] : raw.openers;
    if (!Array.isArray(list)) problem("openers", "a list of page openers (- page: /pricing, after: 20).");
    else {
      const rules: unknown[] = [];
      let ok = true;
      list.forEach((item, i) => {
        if (!isRecord(item)) {
          problem("openers", `opener ${i + 1} must be a map with page and after.`);
          ok = false;
          return;
        }
        unknownKeys(item, ["page", "after", "message", "hint"], `chat.openers[${i + 1}].`, issues);
        if (item.message !== undefined && item.message !== null && item.hint !== undefined) problem("openers", `opener ${i + 1}: hint is only for openers the AI writes (no message).`);
        rules.push({ path: item.page, delay: item.after, text: item.message ?? null, hint: item.hint });
      });
      if (ok) {
        try {
          out.openers = parseOpeners(rules, () => "op_desk").map(openerOf);
        } catch (error) {
          problem("openers", (error as Error).message.replace(/^Opener (\d+)/, "opener $1").replace(/the delay/, "after (the delay)"));
        }
      }
    }
  }
  return out;
}

function openerOf(rule: OpenerRule): DeskOpener {
  return { page: rule.path, after: rule.delay, ...(rule.text !== null ? { message: rule.text } : {}), ...(rule.hint ? { hint: rule.hint } : {}) };
}

function parseHoursSection(raw: Record<string, unknown>, issues: DeskIssue[]): NonNullable<DeskFile["hours"]> {
  const out: NonNullable<DeskFile["hours"]> = {};
  unknownKeys(raw, ["enabled", "timeZone", "days", "awayMessage"], "hours.", issues);
  const problem = (key: string, message: string) => issues.push({ path: DESK_PATH, message: `hours.${key}: ${message}` });
  if (raw.enabled !== undefined) {
    if (bool(raw.enabled)) out.enabled = raw.enabled as boolean;
    else problem("enabled", "use true (use business hours) or false (always open).");
  }
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone === "string" && validTimezone(raw.timeZone.trim())) out.timeZone = raw.timeZone.trim();
    else problem("timeZone", "use a time zone name, like Europe/London, America/New_York or UTC.");
  }
  if (raw.days !== undefined) {
    const days = raw.days === null ? {} : raw.days;
    if (!isRecord(days)) problem("days", 'a map of open days, like monday: "09:00-17:30". Days not listed are closed.');
    else {
      const spans: DayHours[] = [];
      let ok = true;
      for (const [name, value] of Object.entries(days)) {
        const day = DAYS.indexOf(name.toLowerCase() as DayName);
        if (day < 0) {
          problem("days", `"${name}" isn't a weekday (monday … sunday).`);
          ok = false;
          continue;
        }
        if (value === null || value === "closed") continue;
        const match = typeof value === "string" ? TIME_SPAN.exec(value.trim()) : null;
        if (!match) {
          problem(`days.${name}`, 'use opening and closing times, like "09:00-17:30" (24-hour), or closed.');
          ok = false;
          continue;
        }
        spans.push({ day: day as Weekday, start: match[1]!, end: match[2]! });
      }
      if (ok) {
        try {
          out.days = daysOf(parseHours({ timezone: "UTC", days: spans }).days);
        } catch (error) {
          problem("days", (error as Error).message);
        }
      }
    }
  }
  if (raw.awayMessage !== undefined) {
    if (typeof raw.awayMessage !== "string") problem("awayMessage", "text for visitors writing while you're away; {when} becomes the next opening.");
    else if (raw.awayMessage.trim().length > 500) problem("awayMessage", "keep it to 500 characters.");
    else out.awayMessage = raw.awayMessage.trim() || DEFAULT_AWAY_MESSAGE;
  }
  return out;
}

function daysOf(days: DayHours[]): NonNullable<NonNullable<DeskFile["hours"]>["days"]> {
  const out: Partial<Record<DayName, string>> = {};
  for (const name of DAY_ORDER) {
    const span = days.find((d) => DAYS[d.day] === name);
    if (span) out[name] = `${span.start}-${span.end}`;
  }
  return out;
}

function parseInbox(raw: Record<string, unknown>, issues: DeskIssue[]): NonNullable<DeskFile["inbox"]> {
  const out: NonNullable<DeskFile["inbox"]> = {};
  unknownKeys(raw, ["assignment"], "inbox.", issues);
  const assignment = section(raw, "assignment", "inbox.", issues);
  if (assignment) {
    unknownKeys(assignment, ["mode", "capacity"], "inbox.assignment.", issues);
    const a: NonNullable<NonNullable<DeskFile["inbox"]>["assignment"]> = {};
    if (assignment.mode !== undefined) {
      if (assignment.mode === "manual" || assignment.mode === "round_robin") a.mode = assignment.mode;
      else issues.push({ path: DESK_PATH, message: "inbox.assignment.mode: use manual (people pick chats) or round_robin (each new chat goes to the next teammate)." });
    }
    if (assignment.capacity !== undefined) {
      try {
        a.capacity = parseAssignment({ mode: "manual", capacity: assignment.capacity }).capacity;
      } catch (error) {
        issues.push({ path: DESK_PATH, message: `inbox.assignment.capacity: ${(error as Error).message}` });
      }
    }
    out.assignment = a;
  }
  return out;
}

function parseAi(raw: Record<string, unknown>, issues: DeskIssue[]): NonNullable<DeskFile["ai"]> {
  const out: NonNullable<DeskFile["ai"]> = {};
  unknownKeys(raw, ["enabled", "model", "models", "monthlyReplyCap"], "ai.", issues);
  const problem = (key: string, message: string) => issues.push({ path: DESK_PATH, message: `ai.${key}: ${message}` });
  if (raw.enabled !== undefined) {
    if (bool(raw.enabled)) out.enabled = raw.enabled as boolean;
    else problem("enabled", "use true (the AI answers) or false.");
  }
  if (raw.model !== undefined) {
    try {
      out.model = readModel(raw.model) ?? "default";
    } catch (error) {
      problem("model", (error as Error).message);
    }
  }
  if (raw.models !== undefined) {
    try {
      out.models = parseJobModels(raw.models);
    } catch (error) {
      if (!(error instanceof InvalidModelsError)) throw error;
      problem("models", error.message);
    }
  }
  if (raw.monthlyReplyCap !== undefined) {
    try {
      out.monthlyReplyCap = readReplyCap(raw.monthlyReplyCap);
    } catch (error) {
      problem("monthlyReplyCap", (error as Error).message);
    }
  }
  return out;
}

/** desk.yaml → its settings (only the keys it has, checked and tidied) and the problems found. Never throws. */
export function parseDeskFile(text: string, issues: DeskIssue[] = []): DeskFile {
  let data: unknown;
  try {
    data = parseYaml(text, { prettyErrors: true }) ?? {};
  } catch (error) {
    issues.push({ path: DESK_PATH, message: `Invalid YAML: ${(error as Error).message.split("\n")[0]}` });
    return {};
  }
  if (!isRecord(data)) {
    issues.push({ path: DESK_PATH, message: "desk.yaml is a map of sections: ai, chat, hours, inbox." });
    return {};
  }
  unknownKeys(data, ["ai", "chat", "hours", "inbox"], "", issues);
  const desk: DeskFile = {};
  const ai = section(data, "ai", "", issues);
  if (ai) desk.ai = parseAi(ai, issues);
  const chat = section(data, "chat", "", issues);
  if (chat) desk.chat = parseChat(chat, issues);
  const hours = section(data, "hours", "", issues);
  if (hours) desk.hours = parseHoursSection(hours, issues);
  const inbox = section(data, "inbox", "", issues);
  if (inbox) desk.inbox = parseInbox(inbox, issues);
  return desk;
}

// ---------- settings → file ----------

const DEFAULT_HOURS: BusinessHours = {
  enabled: false,
  timezone: "UTC",
  days: [1, 2, 3, 4, 5].map((day) => ({ day: day as Weekday, start: "09:00", end: "17:00" })),
  awayMessage: DEFAULT_AWAY_MESSAGE,
};

function storedHours(stored: unknown): BusinessHours {
  try {
    return stored === undefined || stored === null ? DEFAULT_HOURS : parseHours(stored);
  } catch {
    return DEFAULT_HOURS;
  }
}

/** The whole desk.yaml for the current settings: every key, at its current value (texts at the words visitors see). */
export function deskFromSettings(settings: Record<string, unknown>, ai: DeskAi): DeskFile {
  const look = widgetLook(settings, "", null);
  const hours = storedHours(settings.hours);
  const assignment = assignmentSettings(settings.assignment);
  return {
    ai: { enabled: ai.enabled, model: ai.model ?? "default", models: { ...ai.models }, monthlyReplyCap: ai.monthlyReplyCap },
    chat: {
      name: typeof settings.displayName === "string" ? settings.displayName : "",
      color: look.color,
      mode: look.mode,
      greetingCard: look.greetingCard,
      button: look.buttonStyle,
      position: look.position,
      island: { surface: look.islandSurface, glow: look.neon },
      theme: look.theme,
      rounding: look.radius,
      sound: look.sound,
      greeting: look.greeting,
      replyTime: look.replyTime,
      placeholder: look.placeholder,
      suggestedQuestions: look.suggestions,
      askForRating: settings.csat !== false,
      allowedWebsites: Array.isArray(settings.allowedDomains) ? normalizeDomains(settings.allowedDomains).domains : [],
      offerHelpOnErrors: settings.proactive !== false,
      pageControl: settings.pageControl !== false,
      pageControlConfirm: pageControlConfirm(settings.pageControlConfirm),
      openers: storedOpeners(settings.openers).map(openerOf),
    },
    hours: { enabled: hours.enabled, timeZone: hours.timezone, days: daysOf(hours.days), awayMessage: hours.awayMessage },
    inbox: { assignment: { mode: assignment.mode, capacity: assignment.capacity } },
  };
}

const scalar = (value: unknown) => stringify(value, { lineWidth: 0 }).trimEnd();

/** A key: value line with a comment, indented. */
const line = (indent: number, key: string, value: unknown, comment?: string) => `${" ".repeat(indent)}${key}: ${scalar(value)}${comment ? `  # ${comment}` : ""}`;

function block(indent: number, key: string, value: unknown, comment?: string): string {
  const empty = Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0;
  if (empty || (!Array.isArray(value) && !isRecord(value))) return line(indent, key, value, comment);
  const body = stringify(value, { lineWidth: 0, indent: 2 })
    .trimEnd()
    .split("\n")
    .map((l) => `${" ".repeat(indent + 2)}${l}`)
    .join("\n");
  return `${" ".repeat(indent)}${key}:${comment ? `  # ${comment}` : ""}\n${body}`;
}

export const DESK_HEADER = `# desk.yaml: your Jun desk's settings as code. Saving this file changes them on the desk,
# and changes made on the desk's settings pages are written back here.
# A key or section you leave out is left as it is on the desk.
# Not in this file: logos (upload them on the Appearance page), keys and secrets, the AI provider and
# its sign-in, team members and invites, notifications, and knowledge sources.
`;

/** desk.yaml's text for a full set of settings (deskFromSettings), with a comment on each key. */
export function renderDeskFile(desk: DeskFile): string {
  const out: string[] = [DESK_HEADER];
  const { ai, chat, hours, inbox } = desk;
  if (ai) {
    out.push("ai:");
    if (ai.enabled !== undefined) out.push(line(2, "enabled", ai.enabled, "the AI answers new chats"));
    if (ai.model !== undefined) out.push(line(2, "model", ai.model, "default = the provider's default model"));
    if (ai.models !== undefined) out.push(block(2, "models", ai.models, "a model per job (answer, editor, nudge…), optional"));
    if (ai.monthlyReplyCap !== undefined) out.push(line(2, "monthlyReplyCap", ai.monthlyReplyCap, "AI replies a month; 0 = no limit"));
    out.push("");
  }
  if (chat) {
    out.push("chat:  # the chat widget on your website (the Appearance and Chat widget pages)");
    if (chat.name !== undefined) out.push(line(2, "name", chat.name, "empty = your workspace's name"));
    if (chat.color !== undefined) out.push(line(2, "color", chat.color));
    if (chat.mode !== undefined) out.push(line(2, "mode", chat.mode, "island (a pill at the bottom centre) | window (a button in the corner that opens a chat window)"));
    if (chat.greetingCard !== undefined) out.push(line(2, "greetingCard", chat.greetingCard, "window: a greeting card over the button"));
    if (chat.button !== undefined) out.push(line(2, "button", chat.button, "window: the round button shows your logo or text"));
    if (chat.position !== undefined) out.push(line(2, "position", chat.position, "window: left | right"));
    if (chat.island !== undefined) {
      out.push("  island:  # island only");
      if (chat.island.surface !== undefined) out.push(line(4, "surface", chat.island.surface, "dark | page"));
      if (chat.island.glow !== undefined) out.push(line(4, "glow", chat.island.glow, "the turning multi-colour border"));
    }
    if (chat.theme !== undefined) out.push(line(2, "theme", chat.theme, "auto | light | dark"));
    if (chat.rounding !== undefined) out.push(line(2, "rounding", chat.rounding, "corner rounding, 0 to 24"));
    if (chat.sound !== undefined) out.push(line(2, "sound", chat.sound, "a soft chime for new replies"));
    if (chat.greeting !== undefined) out.push(line(2, "greeting", chat.greeting));
    if (chat.replyTime !== undefined) out.push(line(2, "replyTime", chat.replyTime));
    if (chat.placeholder !== undefined) out.push(line(2, "placeholder", chat.placeholder));
    if (chat.suggestedQuestions !== undefined) out.push(block(2, "suggestedQuestions", chat.suggestedQuestions, "up to 4"));
    if (chat.askForRating !== undefined) out.push(line(2, "askForRating", chat.askForRating, '"How did we do?" when a chat is resolved'));
    if (chat.allowedWebsites !== undefined) out.push(block(2, "allowedWebsites", chat.allowedWebsites, "[] = any website"));
    if (chat.offerHelpOnErrors !== undefined) out.push(line(2, "offerHelpOnErrors", chat.offerHelpOnErrors, "offer help when something breaks on the page"));
    if (chat.pageControl !== undefined) out.push(line(2, "pageControl", chat.pageControl, "the AI may read and use your website (asks before changes)"));
    if (chat.pageControlConfirm !== undefined) out.push(line(2, "pageControlConfirm", chat.pageControlConfirm, "before it clicks, types or chooses: allow-always | every-time | never"));
    if (chat.openers !== undefined) out.push(block(2, "openers", chat.openers, "after: seconds on the page; no message = the AI writes it (hint: what to offer)"));
    out.push("");
  }
  if (hours) {
    out.push("hours:  # business hours");
    if (hours.enabled !== undefined) out.push(line(2, "enabled", hours.enabled, "false = always open"));
    if (hours.timeZone !== undefined) out.push(line(2, "timeZone", hours.timeZone));
    if (hours.days !== undefined) out.push(block(2, "days", hours.days, "open days; days not listed are closed"));
    if (hours.awayMessage !== undefined) out.push(line(2, "awayMessage", hours.awayMessage, "{when} becomes the next opening"));
    out.push("");
  }
  if (inbox?.assignment) {
    out.push("inbox:");
    out.push("  assignment:  # who gets a chat that needs a person");
    if (inbox.assignment.mode !== undefined) out.push(line(4, "mode", inbox.assignment.mode, "manual | round_robin"));
    if (inbox.assignment.capacity !== undefined) out.push(line(4, "capacity", inbox.assignment.capacity, "round robin: most open chats each; 0 = no limit"));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// ---------- comparing ----------

type Leaf = { path: string[]; value: unknown };

/** Values compared as a whole (lists, the per-job models, the days). */
const WHOLE = new Set(["ai.models", "hours.days"]);

/** Every setting in a desk.yaml, one per key (island and assignment are groups of keys). */
export function deskLeaves(desk: DeskFile): Leaf[] {
  const out: Leaf[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (isRecord(value) && !WHOLE.has(path.join("."))) for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    else if (value !== undefined) out.push({ path, value });
  };
  walk(desk, []);
  return out;
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function getPath(desk: DeskFile, path: string[]): unknown {
  let node: unknown = desk;
  for (const key of path) node = isRecord(node) ? node[key] : undefined;
  return node;
}

function setPath(desk: DeskFile, path: string[], value: unknown): void {
  let node = desk as Record<string, unknown>;
  for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[path.at(-1)!] = value;
}

/** The keys of `next` whose value isn't the same in `prev` (all of them when there's no `prev`): what saving it changes. */
export function deskChanges(prev: DeskFile | null, next: DeskFile): DeskFile {
  const out: DeskFile = {};
  for (const { path, value } of deskLeaves(next)) {
    if (prev && sameValue(getPath(prev, path), value)) continue;
    setPath(out, path, value);
  }
  return out;
}

// ---------- file → settings ----------

/**
 * Applies desk.yaml's keys to the stored settings (copies; the inputs aren't changed), through the
 * same checks as the settings routes. Keys it doesn't have stay as they are. Throws an Error with a
 * message for the admin (parseDeskFile reports the same problems first).
 */
export function applyDesk(desk: DeskFile, settings: Record<string, unknown>, ai: DeskAi, newId: () => string): { settings: Record<string, unknown>; ai: DeskAi; inboxChanged: boolean; aiChanged: boolean } {
  const next = structuredClone(settings);
  const body: Record<string, unknown> = {};
  const chat = desk.chat ?? {};
  for (const [key, field] of Object.entries(LOOK_FIELDS)) {
    const value = chat[key as keyof typeof LOOK_FIELDS];
    if (value !== undefined) body[field] = value;
  }
  if (chat.island?.surface !== undefined) body.islandSurface = chat.island.surface;
  if (chat.island?.glow !== undefined) body.neon = chat.island.glow;
  if (chat.sound !== undefined) body.sound = chat.sound;
  if (chat.askForRating !== undefined) body.csat = chat.askForRating;
  if (chat.offerHelpOnErrors !== undefined) body.proactive = chat.offerHelpOnErrors;
  if (chat.pageControl !== undefined) body.pageControl = chat.pageControl;
  if (chat.pageControlConfirm !== undefined) body.pageControlConfirm = chat.pageControlConfirm;
  if (chat.allowedWebsites !== undefined) body.allowedDomains = chat.allowedWebsites;
  if (chat.openers !== undefined) {
    // An opener on the same page keeps its id (its AI line stays cached).
    const old = storedOpeners(settings.openers);
    body.openers = chat.openers.map((o) => {
      const match = old.findIndex((r) => r.path === o.page);
      const id = match >= 0 ? old.splice(match, 1)[0]!.id : undefined;
      return { id, path: o.page, delay: o.after, text: o.message ?? null, hint: o.hint };
    });
  }
  if (desk.hours && Object.keys(desk.hours).length) {
    const h = storedHours(settings.hours);
    const days = desk.hours.days
      ? Object.entries(desk.hours.days).map(([name, span]) => {
          const [start, end] = span!.split("-");
          return { day: DAYS.indexOf(name as DayName), start, end };
        })
      : h.days;
    body.hours = { enabled: desk.hours.enabled ?? h.enabled, timezone: desk.hours.timeZone ?? h.timezone, days, awayMessage: desk.hours.awayMessage ?? h.awayMessage };
  }
  const a = desk.inbox?.assignment;
  if (a && Object.keys(a).length) {
    const current = assignmentSettings(settings.assignment);
    body.assignment = { mode: a.mode ?? current.mode, capacity: a.capacity ?? current.capacity };
  }
  applyInboxPatch(next, body, newId);

  const nextAi: DeskAi = { ...ai, models: { ...ai.models } };
  if (desk.ai?.enabled !== undefined) nextAi.enabled = desk.ai.enabled;
  if (desk.ai?.model !== undefined) nextAi.model = readModel(desk.ai.model);
  if (desk.ai?.models !== undefined) nextAi.models = parseJobModels(desk.ai.models);
  if (desk.ai?.monthlyReplyCap !== undefined) nextAi.monthlyReplyCap = readReplyCap(desk.ai.monthlyReplyCap);
  return { settings: next, ai: nextAi, inboxChanged: !sameValue(next, settings), aiChanged: !sameValue(nextAi, ai) };
}

// ---------- the file after a settings page's change ----------

/** One value set in place: a scalar keeps its comment; a list or map is replaced (keeping the comments on it). */
function put(doc: Document, path: string[], value: unknown): void {
  const node = doc.getIn(path, true);
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    node.value = value;
    return;
  }
  const created = doc.createNode(value);
  if ((isSeq(node) || isMap(node)) && (isSeq(created) || isMap(created))) {
    created.comment = node.comment;
    created.commentBefore = node.commentBefore;
  }
  doc.setIn(path, created);
}

/**
 * desk.yaml after the settings changed from `before` to `after` (both deskFromSettings): every key
 * that changed is set (added if the file doesn't have it), and a key the file has with another value
 * than `after` is set too, so the file says what the desk does. Comments and key order stay. With no
 * file (or one that doesn't parse), the whole file is written. Returns the text unchanged when
 * nothing differs.
 */
export function updateDeskText(text: string | undefined, before: DeskFile, after: DeskFile): string {
  if (text === undefined) return renderDeskFile(after);
  const doc = parseDocument(text);
  if (doc.errors.length || !(isMap(doc.contents) || doc.contents === null)) return renderDeskFile(after);
  const issues: DeskIssue[] = [];
  const inFile = parseDeskFile(text, issues);
  let changed = false;
  try {
    for (const { path, value } of deskLeaves(after)) {
      const has = getPath(inFile, path);
      // Unchanged and not in the file, or already what the file says: nothing to write.
      if ((sameValue(getPath(before, path), value) && has === undefined) || sameValue(has, value)) continue;
      put(doc, path, value);
      changed = true;
    }
    // D-89: an older file's `launcher:` gives way to mode and greetingCard once either is written.
    if (changed && doc.hasIn(["chat", "launcher"]) && (doc.hasIn(["chat", "mode"]) || doc.hasIn(["chat", "greetingCard"]))) {
      doc.deleteIn(["chat", "launcher"]);
      for (const key of ["mode", "greetingCard"] as const) {
        if (after.chat?.[key] !== undefined && !doc.hasIn(["chat", key])) put(doc, ["chat", key], after.chat[key]);
      }
    }
  } catch {
    return renderDeskFile(after); // a shape the edit can't follow (a section that isn't a map)
  }
  return changed ? doc.toString({ lineWidth: 0 }) : text;
}
