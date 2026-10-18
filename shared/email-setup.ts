// C-02 (D-111): setting email up from the desk, pure. An admin pastes a Cloudflare API token once
// (Channels → Email); the Worker then makes the same calls `wrangler email sending enable` and
// `wrangler email routing enable` make, and adds the rule that hands `reply@<domain>` (and so every
// `reply+<token>@<domain>`) to this desk's Worker.

/** The token's permissions, as Cloudflare's token page names them, with the keys that pre-fill it. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { key: "zone", type: "read", label: "Zone: Read", why: "list your domains" },
  { key: "zone_settings", type: "edit", label: "Zone Settings: Edit", why: "turn on Email Routing and its DNS records" },
  { key: "email_routing_rule", type: "edit", label: "Email Routing Rules: Edit", why: "send replies to this desk" },
  { key: "email_sending", type: "edit", label: "Email Sending: Edit", why: "send from your domain" },
  { key: "workers_scripts", type: "read", label: "Workers Scripts: Read", why: "find this desk's Worker on a custom domain" },
] as const;

export type SetupPermission = (typeof CLOUDFLARE_TOKEN_PERMISSIONS)[number]["label"];

/** Cloudflare's "Create token" page with the permissions ticked, all zones, named after the desk. */
export function cloudflareTokenUrl(name: string): string {
  const keys = CLOUDFLARE_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
}

export interface Zone {
  id: string;
  name: string;
  accountId: string;
}

/** The zone a domain lives in (its longest matching zone name), else null. */
export function zoneFor(domain: string, zones: Zone[]): Zone | null {
  const d = domain.toLowerCase();
  let best: Zone | null = null;
  for (const z of zones) {
    const n = z.name.toLowerCase();
    if ((d === n || d.endsWith(`.${n}`)) && (!best || n.length > best.name.length)) best = z;
  }
  return best;
}

/** The Worker's name from a workers.dev address (`<name>.<account>.workers.dev`), else null. */
export function workerNameFromHost(host: string): string | null {
  const match = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(host);
  return match ? match[1]!.toLowerCase() : null;
}

/** One step of the setup, as the page lists it. */
export interface SetupStep {
  id: "token" | "worker" | "sending" | "routing" | "subaddress" | "rule" | "save";
  label: string;
  ok: boolean;
  /** What was done, or why it failed (the admin's next move). */
  detail: string;
}

/** POST …/email/cloudflare/setup's answer. */
export interface SetupResult {
  ok: boolean;
  steps: SetupStep[];
}

/** A failed Cloudflare call, in words for the admin: a permission the token lacks names it. */
export function cloudflareProblem(status: number, message: string, permission: SetupPermission): string {
  if (status === 401 || status === 403 || /auth|permission|unauthori[sz]ed|forbidden/i.test(message)) {
    return `The token can't do this. Give it "${permission}" (edit the token in Cloudflare, or make a new one with the link above).`;
  }
  return message || `Cloudflare answered ${status}.`;
}
