// T-20 (D-151): an anonymous daily "this desk exists" ping, so the project knows how many desks run,
// on which versions, and which features they use. Never names, URLs, emails, messages or customer
// data: a random install id, the version, and counts rounded into ranges. On unless the desk's
// owner turns it off (Settings → This desk) or the Worker has JUN_TELEMETRY=off. The collector
// (`telemetry/`) checks every ping with `readPing` and stores no IP address.

export const TELEMETRY_URL = "https://telemetry.jun.so/v1/ping";
export const TELEMETRY_DOCS = "https://github.com/samarsheikh001/jun#anonymous-usage-ping";

/** Features a desk can report as in use: on in at least one workspace. */
export const TELEMETRY_FEATURES = ["ai", "knowledge", "email", "whatsapp", "identity", "pageControl", "actions", "mcp", "issues"] as const;
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number];

export const AI_PROVIDERS = ["workers-ai", "openai", "chatgpt"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface TelemetryPing {
  v: 1;
  /** Random, made once per desk; says nothing about who runs it. */
  id: string;
  version: string;
  /** Ranges, never exact counts. */
  workspaces: string;
  members: string;
  /** Conversations started in the last 30 days. */
  chats30d: string;
  /** Days since the owner account was created. */
  age: string;
  providers: AiProviderName[];
  features: TelemetryFeature[];
}

/** The real numbers a desk counts before they're rounded (never sent as they are). */
export interface DeskFacts {
  workspaces: number;
  members: number;
  chats30d: number;
  ageDays: number;
  providers: string[];
  features: string[];
}

const RANGES = {
  workspaces: [1, 2, 6],
  members: [1, 2, 6, 21],
  chats30d: [0, 1, 11, 101, 1001, 10001],
  age: [0, 7, 30, 90, 365],
} as const;

/** n → its range: "0", "1", "2-5", "21+"… The edges are each range's first number. */
export function bucket(n: number, edges: readonly number[]): string {
  const value = Math.max(0, Math.floor(n));
  for (let i = edges.length - 1; i >= 0; i--) {
    const from = edges[i]!;
    if (value < from) continue;
    const next = edges[i + 1];
    if (next === undefined) return `${from}+`;
    return next - 1 === from ? `${from}` : `${from}-${next - 1}`;
  }
  return "0";
}

/** Every range a field can take, for the collector's check. */
export function bucketsOf(edges: readonly number[]): string[] {
  const out = edges[0]! > 0 ? ["0"] : [];
  for (let i = 0; i < edges.length; i++) {
    const from = edges[i]!;
    const next = edges[i + 1];
    out.push(next === undefined ? `${from}+` : next - 1 === from ? `${from}` : `${from}-${next - 1}`);
  }
  return out;
}

const pick = <T extends string>(all: readonly T[], values: string[]): T[] => all.filter((x) => values.includes(x));

export function buildPing(id: string, version: string, facts: DeskFacts): TelemetryPing {
  return {
    v: 1,
    id,
    version,
    workspaces: bucket(facts.workspaces, RANGES.workspaces),
    members: bucket(facts.members, RANGES.members),
    chats30d: bucket(facts.chats30d, RANGES.chats30d),
    age: bucket(facts.ageDays, RANGES.age),
    providers: pick(AI_PROVIDERS, facts.providers),
    features: pick(TELEMETRY_FEATURES, facts.features),
  };
}

export const INSTALL_ID = /^ins_[0-9a-f]{32}$/;

export function newInstallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ins_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Off when the Worker says so (JUN_TELEMETRY=off / false / 0) or the owner turned it off. */
export function telemetryOn(envValue: string | undefined, stored: string | null): boolean {
  if (envValue !== undefined && /^(off|false|0|no)$/i.test(envValue.trim())) return false;
  return stored !== "off";
}

/** The collector's check: exactly this shape, or null. Unknown keys and values are refused. */
export function readPing(raw: unknown): TelemetryPing | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const keys = ["v", "id", "version", "workspaces", "members", "chats30d", "age", "providers", "features"];
  if (Object.keys(v).some((k) => !keys.includes(k))) return null;
  if (v.v !== 1 || typeof v.id !== "string" || !INSTALL_ID.test(v.id)) return null;
  if (typeof v.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v.version)) return null;
  for (const [field, edges] of Object.entries(RANGES)) {
    if (typeof v[field] !== "string" || !bucketsOf(edges).includes(v[field] as string)) return null;
  }
  const list = <T extends string>(x: unknown, all: readonly T[]): T[] | null =>
    Array.isArray(x) && x.every((s) => all.includes(s as T)) && new Set(x).size === x.length ? (x as T[]) : null;
  const providers = list(v.providers, AI_PROVIDERS);
  const features = list(v.features, TELEMETRY_FEATURES);
  if (!providers || !features) return null;
  return {
    v: 1, id: v.id, version: v.version,
    workspaces: v.workspaces as string, members: v.members as string, chats30d: v.chats30d as string, age: v.age as string,
    providers, features,
  };
}
