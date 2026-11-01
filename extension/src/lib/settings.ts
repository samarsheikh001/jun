// The extension's settings (E-01, D-155), in chrome.storage.local. The API key is kept under its own
// storage key and only ever sent to its provider. Pure readers, so they're unit tested.

export const SETTINGS_KEY = "jun.settings";
export const KEYS_KEY = "jun.keys";

/** Before a click, typing or a choice: ask with "Always allow on this site" (default), ask every time, or never. */
export type ConfirmMode = "allow-always" | "every-time" | "never";
export const CONFIRM_MODES: ConfirmMode[] = ["allow-always", "every-time", "never"];

/** Whose AI: the person's ChatGPT plan (Sign in with ChatGPT, the default) or an OpenAI API key. */
export type Provider = "chatgpt" | "openai";

export interface Settings {
  provider: Provider;
  /** Empty: the provider's default (DEFAULT_MODELS). */
  model: string;
  /** Mask emails, card-like numbers, tokens and URL query values before the page goes to the AI. */
  mask: boolean;
  confirm: ConfirmMode;
  /** Sites (origins) where the person chose "Always allow". */
  allowed: string[];
}

export interface Keys {
  openai: string;
}

/** As the desk's (worker/ai/models.ts DEFAULT_MODELS): small and fast on the plan, the API's default otherwise. */
export const DEFAULT_MODELS: Record<Provider, string> = { chatgpt: "gpt-6-luna", openai: "gpt-6.1-sol" };
export const DEFAULT_SETTINGS: Settings = { provider: "chatgpt", model: "", mask: true, confirm: "allow-always", allowed: [] };

export function modelOf(settings: Settings): string {
  return settings.model || DEFAULT_MODELS[settings.provider];
}

const record = (raw: unknown): Record<string, unknown> => (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

export function readSettings(raw: unknown): Settings {
  const s = record(raw);
  const provider: Provider = s.provider === "openai" ? "openai" : "chatgpt";
  const model = typeof s.model === "string" ? s.model.trim().slice(0, 100) : "";
  const confirm = CONFIRM_MODES.includes(s.confirm as ConfirmMode) ? (s.confirm as ConfirmMode) : DEFAULT_SETTINGS.confirm;
  const allowed = Array.isArray(s.allowed) ? [...new Set(s.allowed.filter((o): o is string => typeof o === "string" && /^https?:\/\/[^/]+$/.test(o)))].slice(0, 200) : [];
  return { provider, model, mask: s.mask !== false, confirm, allowed };
}

export function readKeys(raw: unknown): Keys {
  const k = record(raw);
  return { openai: typeof k.openai === "string" ? k.openai.trim() : "" };
}

/** Whether a click, typing or choice on this site waits for the person's Confirm. */
export function needsConfirm(settings: Settings, risk: "auto" | "confirm", origin: string): boolean {
  if (risk === "auto" || settings.confirm === "never") return false;
  return settings.confirm === "every-time" || !settings.allowed.includes(origin);
}

export type Site = { origin: string; pattern: string; host: string };

/** The page a tab shows, if Jun may work on it: http(s) only, never the browser's or the Web Store's own pages. */
export function siteOf(url: string | undefined): Site | { problem: "no-access" | "restricted" } {
  if (!url) return { problem: "no-access" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { problem: "no-access" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { problem: "restricted" };
  if (u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"))) return { problem: "restricted" };
  return { origin: u.origin, pattern: `${u.origin}/*`, host: u.host };
}
