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

export function workspaceSummary(row: WorkspaceSummaryRow): WorkspaceSummary {
  let s: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.settings ?? "{}");
    if (parsed && typeof parsed === "object") s = parsed as Record<string, unknown>;
  } catch {
    // Unreadable settings: the defaults.
  }
  // The widget's public logo URLs (the widget key is public: it's in the install snippet).
  const base = row.widgetKey ? `/api/widget/${encodeURIComponent(row.widgetKey)}` : null;
  const logo = (key: unknown, path: string) => (base && typeof key === "string" ? `${base}/${path}?v=${encodeURIComponent(key)}` : null);
  const installedOn = typeof s.installedOn === "string" && s.installedOn ? s.installedOn : null;
  return {
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceSlug: row.workspaceSlug ?? "",
    role: row.role,
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : APPEARANCE_DEFAULTS.color,
    logoUrl: logo(s.logoKey, "logo"),
    logoDarkUrl: logo(s.logoDarkKey, "logo-dark"),
    installedOn,
    installed: installedOn !== null || typeof s.installedAt === "number" || Boolean(row.installMarked),
    open: row.open ?? 0,
    waiting: row.waiting ?? 0,
    aiOn: row.aiEnabled === 1,
  };
}
