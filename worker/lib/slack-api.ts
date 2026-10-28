import { safeEqual } from "./crypto.ts";

// C-09 (D-152): the few Slack Web API calls the desk makes, and the check that a request really came
// from Slack. Injected fetch (tests); SLACK_API_URL overrides the endpoint (the e2e's mock Slack).

export interface SlackKeys {
  token: string;
  signingSecret: string;
}

export interface SlackUser {
  name: string;
  email: string | null;
}

/** A Slack API answer that wasn't `ok`: `code` is Slack's error string (e.g. "channel_not_found"). */
export class SlackError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? `Slack said ${code}.`);
    this.code = code;
  }
}

/** Errors that mean the connection itself is broken (an admin has to fix it), not one message. */
export const BROKEN_CODES = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "team_access_not_granted",
]);

/** What an admin reads about a broken connection. */
export function brokenText(code: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return "Slack doesn't accept the bot token any more (the app was removed or reinstalled). Paste the current token again.";
    case "missing_scope":
    case "no_permission":
      return "The Slack app is missing a permission. Create it again from the desk's link (or add the scopes), reinstall, and paste the new token.";
    case "channel_not_found":
    case "is_archived":
      return "The Slack channel is gone or archived. Pick another channel.";
    case "not_in_channel":
      return "The bot isn't in the channel any more. Invite it again (/invite @Jun) or pick another channel.";
    default:
      return `Slack said ${code}.`;
  }
}

type Fetch = typeof fetch;

/** `env`: the Worker's (only its optional SLACK_API_URL is read). */
export function slackApi(env: object, token: string, fetchImpl: Fetch = fetch) {
  const base = ((env as { SLACK_API_URL?: string }).SLACK_API_URL || "https://slack.com/api").replace(/\/$/, "");
  async function call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>, form = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
        },
        body: form ? new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      // Rate limited: wait as told, once, if it's short (about one message a second per channel).
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get("retry-after")) || 1;
        if (wait <= 5) {
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
          continue;
        }
      }
      if (res.status === 429) throw new SlackError("ratelimited", "Slack is rate limiting this app. Try again in a minute.");
      const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok?: boolean; error?: string } & T;
      if (!data.ok) throw new SlackError(data.error ?? `http_${res.status}`);
      return data;
    }
  }
  return {
    authTest: () => call<{ team_id: string; team: string; url: string; user_id: string; bot_id?: string }>("auth.test", {}),
    postMessage: (body: Record<string, unknown>) => call<{ ts: string; channel: string }>("chat.postMessage", { unfurl_links: false, unfurl_media: false, ...body }),
    update: (body: Record<string, unknown>) => call("chat.update", body),
    postEphemeral: (body: Record<string, unknown>) => call("chat.postEphemeral", body),
    join: (channel: string) => call("conversations.join", { channel }),
    info: (channel: string) => call<{ channel: { id: string; name: string; is_private: boolean; is_member: boolean; is_archived: boolean } }>("conversations.info", { channel }, true),
    channels: async () => {
      const out: { id: string; name: string; is_private: boolean; is_member: boolean }[] = [];
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const data = await call<{ channels: typeof out; response_metadata?: { next_cursor?: string } }>(
          "conversations.list",
          { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) },
          true,
        );
        out.push(...data.channels);
        cursor = data.response_metadata?.next_cursor ?? "";
        if (!cursor) break;
      }
      return out;
    },
    user: async (user: string): Promise<SlackUser> => {
      const data = await call<{ user: { name: string; real_name?: string; profile?: { email?: string; display_name?: string; real_name?: string } } }>("users.info", { user }, true);
      const p = data.user.profile ?? {};
      return { name: p.display_name || p.real_name || data.user.real_name || data.user.name, email: p.email ?? null };
    },
    openView: (triggerId: string, view: Record<string, unknown>) => call("views.open", { trigger_id: triggerId, view }),
  };
}

export type SlackApi = ReturnType<typeof slackApi>;

/**
 * Slack's request signature: `v0=` + hex HMAC-SHA256(signing secret, `v0:{timestamp}:{raw body}`),
 * the timestamp within 5 minutes. Compared in constant time.
 */
export async function validSlackSignature(secret: string, timestamp: string | null, signature: string | null, rawBody: string, now = Date.now()): Promise<boolean> {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)));
  const expected = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return safeEqual(expected, signature);
}
