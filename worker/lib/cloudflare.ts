import { replyRuleAddress } from "../../shared/email.ts";
import { cloudflareProblem, workerNameFromHost, zoneFor, type SetupPermission, type SetupStep, type Zone } from "../../shared/email-setup.ts";

// C-02 (D-111): the Cloudflare API calls behind Channels → Email's one-button setup, with the
// admin's pasted token. The same calls `wrangler email sending enable`, `wrangler email routing
// enable` and `wrangler email routing rules create` make. `fetch` is injected for tests.

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

export type CloudflareCall = <T>(method: string, path: string, body?: unknown) => Promise<{ result: T; totalPages: number }>;

export function cloudflareApi(token: string, fetcher: typeof fetch = fetch): CloudflareCall {
  return async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetcher(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !json?.success) {
      const message = json?.errors?.map((e) => e.message).join("; ") || `Cloudflare answered ${response.status}`;
      throw new CloudflareError(response.status, message);
    }
    return { result: json.result, totalPages: json.result_info?.total_pages ?? 1 };
  };
}

/** Every zone (domain) the token can see, up to 1,000. */
export async function listZones(call: CloudflareCall): Promise<Zone[]> {
  const zones: Zone[] = [];
  for (let page = 1; page <= 20; page++) {
    const { result, totalPages } = await call<{ id: string; name: string; account: { id: string } }[]>("GET", `/zones?per_page=50&page=${page}`);
    zones.push(...result.map((z) => ({ id: z.id, name: z.name, accountId: z.account.id })));
    if (page >= totalPages) break;
  }
  return zones;
}

/** This desk's Worker: from its workers.dev address, else the custom domain it's served on. */
export async function findWorkerName(call: CloudflareCall, host: string, accountIds: string[]): Promise<string | null> {
  const fromHost = workerNameFromHost(host);
  if (fromHost) return fromHost;
  for (const account of new Set(accountIds)) {
    try {
      const { result } = await call<{ hostname: string; service: string }[]>("GET", `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(host)}`);
      const match = result.find((d) => d.hostname.toLowerCase() === host.toLowerCase());
      if (match) return match.service;
    } catch {
      // No access to this account's Workers: try the next.
    }
  }
  return null;
}

interface RoutingRule {
  id?: string;
  tag?: string;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

/**
 * Runs the setup: Email Sending on the from address's domain, Email Routing (with subaddressing) on
 * the reply domain, and a rule handing `reply@<reply domain>` to this desk's Worker. Each step is
 * tried even if one before it failed (sending and receiving don't depend on each other); a step
 * already done says so. Nothing here is saved on the desk.
 */
export async function runEmailSetup(
  call: CloudflareCall,
  input: { zones: Zone[]; fromDomain: string; replyDomain: string; workerName: string | null },
): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  const step = async (id: SetupStep["id"], label: string, permission: SetupPermission, run: () => Promise<string>) => {
    try {
      steps.push({ id, label, ok: true, detail: await run() });
    } catch (error) {
      const detail = error instanceof CloudflareError ? cloudflareProblem(error.status, error.message, permission) : (error as Error).message;
      steps.push({ id, label, ok: false, detail });
    }
  };
  const notIn = (domain: string) => new Error(`${domain} isn't a domain in this Cloudflare account (or the token can't see it). Add it to Cloudflare first, or pick another.`);

  const sendZone = zoneFor(input.fromDomain, input.zones);
  await step("sending", `Send from ${input.fromDomain}`, "Email Sending: Edit", async () => {
    if (!sendZone) throw notIn(input.fromDomain);
    const { result } = await call<{ name: string; enabled: boolean }[]>("GET", `/zones/${sendZone.id}/email/sending/subdomains`);
    if (result.some((s) => s.name.toLowerCase() === input.fromDomain && s.enabled)) return "Already on.";
    await call("POST", `/zones/${sendZone.id}/email/sending/subdomains`, { name: input.fromDomain });
    return "Turned on. Cloudflare added the SPF and DKIM records; they can take a few minutes to work.";
  });

  const replyZone = zoneFor(input.replyDomain, input.zones);
  await step("routing", `Receive at ${input.replyDomain}`, "Zone Settings: Edit", async () => {
    if (!replyZone) throw notIn(input.replyDomain);
    try {
      await call("POST", `/zones/${replyZone.id}/email/routing/dns`, input.replyDomain === replyZone.name ? {} : { name: input.replyDomain });
    } catch (error) {
      if (error instanceof CloudflareError && /already/i.test(error.message)) return "Already on.";
      throw error;
    }
    return "Email Routing is on, and Cloudflare added its MX records.";
  });
  await step("subaddress", "Accept reply+… addresses", "Zone Settings: Edit", async () => {
    if (!replyZone) throw notIn(input.replyDomain);
    await call("PATCH", `/zones/${replyZone.id}/email/routing`, { support_subaddress: true });
    return "Subaddressing is on, so every conversation's reply+… address reaches the rule below.";
  });

  const address = replyRuleAddress(input.replyDomain);
  await step("rule", `Send ${address} to this desk`, "Email Routing Rules: Edit", async () => {
    if (!replyZone) throw notIn(input.replyDomain);
    if (!input.workerName) throw new Error("Couldn't tell this desk's Worker name. Type it below (Workers & Pages in Cloudflare lists it).");
    const body = {
      name: "Jun desk: customers' email replies",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [input.workerName] }],
    };
    const { result } = await call<RoutingRule[]>("GET", `/zones/${replyZone.id}/email/routing/rules?per_page=50`);
    const existing = result.find((r) => r.matchers.some((m) => m.type === "literal" && m.value?.toLowerCase() === address));
    if (existing) {
      const ours = existing.actions.some((a) => a.type === "worker" && a.value?.includes(input.workerName!));
      if (ours) return "Already there.";
      await call("PUT", `/zones/${replyZone.id}/email/routing/rules/${existing.id ?? existing.tag}`, body);
      return `Updated: ${address} now goes to the Worker ${input.workerName}.`;
    }
    await call("POST", `/zones/${replyZone.id}/email/routing/rules`, body);
    return `Added: ${address} goes to the Worker ${input.workerName}.`;
  });
  return steps;
}
