// Debug context captured by the widget loader on the customer's site (P1: support that
// sees the bug). Shared by the Worker (server-side sanitising, AI prompt) and the
// dashboard (timeline). The loader (public/widget.js) applies the same redaction rules
// in plain JS; keep them in sync.

/**
 * app_error: the host app's own words, from JunDesk.reportError({ message, code? }) (S-12).
 * app_event: something the visitor did in the host app, from JunDesk.track(name, props?) (V-15).
 * rage_click: the same element clicked 3+ times within a second, with no DOM change (S-02).
 * dead_click: one click on a button or link and nothing on the page changed for 2.5 s (PostHog's rule).
 * stuck: same page for 3+ visible minutes after an issue, with no successful submit (S-13).
 */
export type DebugEventKind = "error" | "network" | "navigation" | "app_error" | "app_event" | "rage_click" | "dead_click" | "stuck";

/**
 * rage_click / dead_click: what was clicked, never its value. `text` is the visible label of a button or
 * link only (tag a/button or role=button), at most 40 chars; other elements' text is never kept.
 */
export interface DebugTarget {
  tag: string;
  id?: string;
  /** aria-label */
  label?: string;
  name?: string;
  role?: string;
  text?: string;
}

export interface DebugEvent {
  /** Epoch ms. */
  t: number;
  kind: DebugEventKind;
  /** error / app_error: message; network: error text for failures without a status. */
  message?: string;
  /** app_error: the app's optional error code (`[\w.-]`, at most 60 chars). */
  code?: string;
  /** app_event: its name (`[\w.:/ -]`, at most 60 chars). */
  name?: string;
  /** app_event: up to 10 properties; strings masked, at most 100 chars. */
  props?: Record<string, string | number | boolean>;
  /** error: "file:line"; */
  source?: string;
  /** error: first lines of the stack. */
  stack?: string;
  /** network */
  method?: string;
  /** network / navigation: path (+ query keys only) for same-site URLs, origin+path otherwise. stuck: page path only. */
  url?: string;
  /** network: HTTP status, or 0 for a network failure / blocked resource. */
  status?: number;
  durationMs?: number;
  /** navigation: how the page was reached, for the first page of a page load (absent for in-app navigation). */
  how?: NavigationHow;
  /** rage_click / dead_click */
  target?: DebugTarget;
  /** rage_click: clicks in the burst. */
  count?: number;
  /** stuck: visible seconds on the page. */
  seconds?: number;
  /** stuck: the kind of the earlier issue. */
  issue?: DebugEventKind;
}

export type NavigationHow = "open" | "reload" | "back";
const HOW = new Set<NavigationHow>(["open", "reload", "back"]);

export interface DebugContext {
  page: { url: string; title: string };
  userAgent: string;
  viewport: { w: number; h: number };
  language: string;
  timezone: string;
  /** Epoch ms when the browser took the snapshot. */
  capturedAt: number;
  events: DebugEvent[];
}

export const MAX_DEBUG_EVENTS = 50;
const MAX_TEXT = 500;

/** Masks personal data and secrets in free text (error messages, stacks, titles). */
export function redact(input: unknown, max = MAX_TEXT): string {
  return String(input ?? "")
    .slice(0, max * 2)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
    .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[token]")
    .replace(/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[key]")
    .replace(/((?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth\w*|session\w*|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[redacted]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
    .slice(0, max);
}

/** Campaign tags keep their values (`utm_source=google`): they name an ad, never a person. */
const UTM = /^utm_(source|medium|campaign|term|content)$/;
export const utmValue = (v: string) => redact(v, 80).replace(/[\s&#=?]+/g, "-");

/**
 * Keeps a URL's path but never query values (they often hold tokens, emails, ids), except
 * campaign tags; a hash route (`#/settings`) stays without its own query, a plain #anchor goes.
 */
export function cleanUrl(input: unknown, pageOrigin?: string): string {
  const raw = String(input ?? "").slice(0, 2000);
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    const url = new URL(raw, pageOrigin ?? "https://relative.invalid");
    const keys = [...new Set(url.searchParams.keys())].slice(0, 10);
    const query = keys.length ? `?${keys.map((k) => `${redact(k, 40)}=${UTM.test(k) ? utmValue(url.searchParams.get(k) ?? "") : "…"}`).join("&")}` : "";
    const path = redact(url.pathname, 300) + query + (/^#!?\//.test(url.hash) ? redact(url.hash.split("?")[0], 200) : "");
    // Same-site (or relative) URLs become paths; other sites keep their origin.
    const sameSite = !absolute || (pageOrigin !== undefined && url.origin === new URL(pageOrigin).origin);
    return sameSite ? path : `${url.origin}${path}`;
  } catch {
    return redact(raw.split(/[?#]/)[0], 300);
  }
}

const KINDS = new Set<DebugEventKind>(["error", "network", "navigation", "app_error", "app_event", "rage_click", "dead_click", "stuck"]);
/** What can come before a `stuck` event (S-13). */
const STUCK_AFTER = new Set<DebugEventKind>(["error", "network", "app_error", "rage_click"]);
export const MAX_APP_ERROR = 300;
/** A button's or link's visible label is kept only up to this length (longer: dropped, not cut). */
export const MAX_TARGET_TEXT = 40;

/** Only the listed target fields, masked and capped; null without a plausible tag name. */
export function cleanTarget(input: unknown): DebugTarget | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const tag = typeof r.tag === "string" ? r.tag.toLowerCase() : "";
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(tag)) return null;
  const out: DebugTarget = { tag };
  const str = (v: unknown, max: number) => (typeof v === "string" ? redact(v.replace(/\s+/g, " ").trim(), max).trim() : "");
  const id = str(r.id, 60);
  if (id) out.id = id;
  const label = str(r.label, 60);
  if (label) out.label = label;
  const name = str(r.name, 60);
  if (name) out.name = name;
  const role = typeof r.role === "string" ? r.role.toLowerCase() : "";
  if (/^[a-z]{1,20}$/.test(role)) out.role = role;
  // Visible text only for buttons and links, and only short labels.
  const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
  if (text && text.length <= MAX_TARGET_TEXT && (tag === "a" || tag === "button" || out.role === "button")) out.text = redact(text, MAX_TARGET_TEXT);
  return out;
}

/** `button#save "Save changes"`, for timelines, prompts and issues. */
export function describeTarget(t: DebugTarget | undefined): string {
  if (!t) return "an element";
  let s = t.tag + (t.id ? `#${t.id}` : "") + (t.role ? `[role=${t.role}]` : "") + (t.name ? `[name=${t.name}]` : "");
  if (t.label) s += ` (${t.label})`;
  if (t.text) s += ` "${t.text}"`;
  return s;
}

export const MAX_EVENT_NAME = 60;
const MAX_EVENT_PROPS = 10;

/** V-15: up to 10 properties with `[\w.-]` keys; strings masked (≤ 100), finite numbers, booleans. */
export function cleanProps(input: unknown): Record<string, string | number | boolean> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_EVENT_PROPS) break;
    if (!/^[\w.-]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = redact(v, 100);
    else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : null;
}

/** "format: csv, rows: 3". */
export function describeProps(props: DebugEvent["props"]): string {
  return Object.entries(props ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
}

/** An app error code: masked, then only `[\w.-]`, at most 60 chars; "" when nothing's left. */
export function cleanCode(input: unknown): string {
  return typeof input === "string" ? redact(input, 60).replace(/[^\w.-]/g, "") : "";
}

/**
 * Validates and re-redacts context from the browser. Never trust the client: unknown
 * fields are dropped, strings are capped and masked again, URLs lose query values.
 */
export function sanitizeContext(raw: unknown): DebugContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const page = (r.page ?? {}) as Record<string, unknown>;
  let origin: string | undefined;
  try {
    origin = new URL(String(page.url ?? "")).origin;
  } catch {
    origin = undefined;
  }
  const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const viewport = (r.viewport ?? {}) as Record<string, unknown>;

  const events: DebugEvent[] = [];
  for (const e of Array.isArray(r.events) ? r.events.slice(-MAX_DEBUG_EVENTS) : []) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    if (!KINDS.has(ev.kind as DebugEventKind)) continue;
    const out: DebugEvent = { t: num(ev.t), kind: ev.kind as DebugEventKind };
    if (out.kind === "app_error") {
      // Only what reportError() sends: a message and an optional code.
      const message = typeof ev.message === "string" ? redact(ev.message.trim(), MAX_APP_ERROR) : "";
      if (!message) continue;
      out.message = message;
      const code = cleanCode(ev.code);
      if (code) out.code = code;
      events.push(out);
      continue;
    }
    if (out.kind === "app_event") {
      // V-15: only a name and a few simple properties, masked again.
      const name = typeof ev.name === "string" ? redact(ev.name.trim().replace(/[^\w.:/ -]/g, ""), MAX_EVENT_NAME).trim() : "";
      if (!name) continue;
      out.name = name;
      const props = cleanProps(ev.props);
      if (props) out.props = props;
      events.push(out);
      continue;
    }
    if (out.kind === "rage_click" || out.kind === "dead_click") {
      // S-02: only what was clicked (safe description) and, for a rage click, how often.
      const target = cleanTarget(ev.target);
      if (!target) continue;
      out.target = target;
      if (out.kind === "rage_click") out.count = Math.max(1, Math.min(100, Math.trunc(num(ev.count, 3))));
      events.push(out);
      continue;
    }
    if (out.kind === "stuck") {
      // S-13: the page path (never a query), the visible time on it, and what went wrong before.
      if (typeof ev.url === "string") out.url = cleanUrl(ev.url.split(/[?#]/)[0], origin);
      out.seconds = Math.max(0, Math.min(86_400, Math.trunc(num(ev.seconds))));
      if (STUCK_AFTER.has(ev.issue as DebugEventKind)) out.issue = ev.issue as DebugEventKind;
      events.push(out);
      continue;
    }
    if (ev.message != null) out.message = redact(ev.message);
    if (ev.source != null) out.source = redact(ev.source, 300);
    if (ev.stack != null) out.stack = redact(ev.stack, 800).split("\n").slice(0, 5).join("\n");
    if (ev.method != null) out.method = String(ev.method).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
    if (ev.url != null) out.url = cleanUrl(ev.url, origin);
    if (out.kind === "navigation" && HOW.has(ev.how as NavigationHow)) out.how = ev.how as NavigationHow;
    if (ev.status != null) out.status = Math.max(0, Math.min(999, Math.trunc(num(ev.status))));
    if (ev.durationMs != null) out.durationMs = Math.max(0, Math.trunc(num(ev.durationMs)));
    events.push(out);
  }
  events.sort((a, b) => a.t - b.t);

  return {
    page: { url: cleanUrl(page.url ?? ""), title: redact(page.title ?? "", 200) },
    userAgent: String(r.userAgent ?? "").slice(0, 300),
    viewport: { w: Math.trunc(num(viewport.w)), h: Math.trunc(num(viewport.h)) },
    language: String(r.language ?? "").slice(0, 20),
    timezone: String(r.timezone ?? "").slice(0, 60),
    capturedAt: num(r.capturedAt, Date.now()),
    events,
  };
}

/**
 * Errors (the browser's and the app's own), failed requests and rage clicks (what the inbox
 * badge counts). Not `stuck`: it always follows an issue that's already counted.
 */
export function isIssue(e: DebugEvent): boolean {
  return e.kind === "error" || e.kind === "app_error" || e.kind === "rage_click" || (e.kind === "network" && (e.status === 0 || (e.status ?? 0) >= 400));
}

const ISSUE_WORDS: Partial<Record<DebugEventKind, string>> = {
  error: "a JavaScript error",
  network: "a failed request",
  app_error: "an error the app reported",
  rage_click: "repeated clicks that did nothing",
};

/** "a failed request", for `stuck` events. */
export function describeIssueKind(kind: DebugEventKind | undefined): string {
  return (kind && ISSUE_WORDS[kind]) || "an earlier problem";
}

/** "3 min" / "45 s". */
export function formatDuration(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
}

/** "14:02:11" in the visitor's timezone when known. */
export function formatEventTime(t: number, timezone?: string): string {
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false, ...(timezone ? { timeZone: timezone } : {}) });
  } catch {
    return new Date(t).toISOString().slice(11, 19);
  }
}

/**
 * One line per event, oldest first, for the AI prompt and handoff briefs. App error codes
 * (S-12) are for engineering: the live AI never gets them, so it can't repeat one to a visitor;
 * issue drafts pass `codes: true`.
 */
export function describeEvents(context: DebugContext, options: { codes?: boolean } = {}): string[] {
  return context.events.map((e) => {
    const at = formatEventTime(e.t, context.timezone);
    if (e.kind === "navigation") return `[${at}] ${e.how === "reload" ? "Reloaded" : e.how === "back" ? "Went back to" : "Visited"} ${e.url}`;
    if (e.kind === "network") {
      const outcome = e.status ? `HTTP ${e.status}` : `failed${e.message ? ` (${e.message})` : ""}`;
      return `[${at}] ${e.method ?? "GET"} ${e.url} → ${outcome}${e.durationMs != null ? ` in ${e.durationMs} ms` : ""}`;
    }
    if (e.kind === "app_event") return `[${at}] In the app: ${e.name}${e.props ? ` (${describeProps(e.props)})` : ""}`;
    if (e.kind === "app_error") return `[${at}] The app reported an error: ${e.message}${options.codes && e.code ? ` (code ${e.code})` : ""}`;
    if (e.kind === "rage_click") return `[${at}] Clicked ${describeTarget(e.target)} ${e.count ?? 3} times in quick succession; the page didn't change`;
    if (e.kind === "dead_click") return `[${at}] Clicked ${describeTarget(e.target)}; nothing on the page changed for 2.5 s`;
    if (e.kind === "stuck") return `[${at}] Still on ${e.url ?? "the same page"} after ${formatDuration(e.seconds ?? 0)} since ${describeIssueKind(e.issue)}, with no successful form submit`;
    return `[${at}] JavaScript error: ${e.message}${e.source ? ` at ${e.source}` : ""}`;
  });
}

/**
 * Crawlers, link previews, uptime checks and headless browsers: never on the visitor list.
 * The loader has the same pattern (plus navigator.webdriver); keep them in sync.
 */
export const BOT_UA = /bot\b|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|phantom/i;

/** "Chrome 141" from a user agent string (good enough for a support panel or an issue). */
export function browserName(ua: string): string {
  const version = (re: RegExp) => re.exec(ua)?.[1];
  if (version(/Edg\/(\d+)/)) return `Edge ${version(/Edg\/(\d+)/)}`;
  if (version(/Firefox\/(\d+)/)) return `Firefox ${version(/Firefox\/(\d+)/)}`;
  if (version(/Chrome\/(\d+)/)) return `Chrome ${version(/Chrome\/(\d+)/)}`;
  if (/Safari/.test(ua) && version(/Version\/(\d+)/)) return `Safari ${version(/Version\/(\d+)/)}`;
  return "Unknown browser";
}

/** "Windows", "macOS", … or "" when the user agent doesn't say. */
export function osName(ua: string): string {
  return /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
}

/** "Chrome 141 on Windows". */
export function describeBrowser(ua: string): string {
  const os = osName(ua);
  return os ? `${browserName(ua)} on ${os}` : browserName(ua);
}
