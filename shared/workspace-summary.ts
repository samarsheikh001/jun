import { APPEARANCE_DEFAULTS } from "./appearance.ts";

// D-97: one card per workspace on the desk's home (`GET /api/workspaces`). Pure, so the Worker's
// one query turns into cards the same way on Node's tests.

export type WorkspaceRole = "owner" | "admin" | "agent";

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
  /** The widget's colour, for the initial's tile when there's no logo. */
  color: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  /** Where the widget was first seen (onboarding's install host), or null. */
  installedOn: string | null;
  /** Seen on a site, or ticked by "I've added it". */
  installed: boolean;
  /** Open conversations. */
  open: number;
  /** Open ones a person has to answer (handed off, or the AI isn't on them). */
  waiting: number;
  aiOn: boolean;
}

export interface WorkspaceSummaryRow {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string | null;
  role: WorkspaceRole;
  widgetKey: string | null;
  settings: string | null;
  installMarked: number | string | null;
  aiEnabled: number | null;
  open: number | null;
  waiting: number | null;
}

const HEX = /^#[0-9a-f]{6}$/i;

function readSettings(settings: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(settings ?? "{}");
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Unreadable settings: the defaults.
  }
  return {};
}

/**
 * The workspace's logos as uploaded for its widget (Chat widget → Appearance): public URLs, since the
 * widget key is in the install snippet anyway. Null when none is uploaded. Also on `/me` for the
 * sidebar's workspace switcher.
 */
export function workspaceLogos(widgetKey: string | null, settings: string | Record<string, unknown> | null): { logoUrl: string | null; logoDarkUrl: string | null } {
  const s = typeof settings === "string" || settings === null ? readSettings(settings) : settings;
  const base = widgetKey ? `/api/widget/${encodeURIComponent(widgetKey)}` : null;
  const logo = (key: unknown, path: string) => (base && typeof key === "string" ? `${base}/${path}?v=${encodeURIComponent(key)}` : null);
  return { logoUrl: logo(s.logoKey, "logo"), logoDarkUrl: logo(s.logoDarkKey, "logo-dark") };
}

export function workspaceSummary(row: WorkspaceSummaryRow): WorkspaceSummary {
  const s = readSettings(row.settings);
  const installedOn = typeof s.installedOn === "string" && s.installedOn ? s.installedOn : null;
  return {
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceSlug: row.workspaceSlug ?? "",
    role: row.role,
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : APPEARANCE_DEFAULTS.color,
    ...workspaceLogos(row.widgetKey, s),
    installedOn,
    installed: installedOn !== null || typeof s.installedAt === "number" || Boolean(row.installMarked),
    open: row.open ?? 0,
    waiting: row.waiting ?? 0,
    aiOn: row.aiEnabled === 1,
  };
}
