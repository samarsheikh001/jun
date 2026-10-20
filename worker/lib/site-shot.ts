// D-141: a picture of the website a workspace's widget runs on, for its card on the desk's home.
// Browser Run's screenshot Quick Action when the desk has the BROWSER binding, else the site's own
// og:image / twitter:image; kept in R2 for a day (`site-shot/<workspace>`), so the browser runs at
// most once a day per workspace. Only public http(s) sites: never this desk, localhost or private IPs.

const KEY = (workspaceId: string) => `site-shot/${workspaceId}`;
const FRESH_MS = 24 * 60 * 60 * 1000;
/** A failure is remembered for an hour, so a broken site isn't retried on every page load. */
const RETRY_MS = 60 * 60 * 1000;
const MAX_BYTES = 2_000_000;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

/** The site to picture, from onboarding's install origin; null when it isn't a public web origin. */
export function siteOrigin(installedOn: string | null, deskOrigin: string): string | null {
  if (!installedOn) return null;
  let url: URL;
  try {
    url = new URL(installedOn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (PRIVATE.test(url.hostname) || url.origin === deskOrigin) return null;
  return url.origin;
}

export const forgetSiteShot = (env: Env, workspaceId: string) => env.FILES.delete(KEY(workspaceId));

export interface SiteShot { body: ArrayBuffer; type: string }

export async function siteShot(env: Env, workspaceId: string, origin: string): Promise<SiteShot | null> {
  const stored = await env.FILES.get(KEY(workspaceId));
  const meta = stored?.customMetadata ?? {};
  const age = Date.now() - Number(meta.at ?? 0);
  if (stored && meta.origin === origin) {
    if (meta.failed && age < RETRY_MS) return null;
    if (!meta.failed && age < FRESH_MS) return { body: await stored.arrayBuffer(), type: stored.httpMetadata?.contentType ?? "image/png" };
  }
  const shot = (await browserShot(env, origin)) ?? (await ogImage(origin));
  await env.FILES.put(KEY(workspaceId), shot?.body ?? new ArrayBuffer(0), {
    httpMetadata: { contentType: shot?.type ?? "application/octet-stream" },
    customMetadata: { origin, at: String(Date.now()), ...(shot ? {} : { failed: "1" }) },
  });
  return shot;
}

async function browserShot(env: Env, origin: string): Promise<SiteShot | null> {
  if (!(env as Partial<Env>).BROWSER) return null;
  try {
    const response = await env.BROWSER.quickAction("screenshot", {
      url: origin,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
      screenshotOptions: { type: "jpeg", quality: 70 },
    });
    if (!response.ok) return null;
    const body = await response.arrayBuffer();
    return body.byteLength && body.byteLength <= MAX_BYTES ? { body, type: "image/jpeg" } : null;
  } catch {
    return null;
  }
}

/** The page's share image: og:image, else twitter:image, resolved against the page. */
async function ogImage(origin: string): Promise<SiteShot | null> {
  try {
    const page = await fetch(origin, { headers: { "user-agent": "Mozilla/5.0 (compatible; JunDesk/1.0; +https://jun.so)", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) return null;
    let found: string | null = null;
    let twitter: string | null = null;
    await new HTMLRewriter()
      .on("meta", {
        element(el) {
          const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
          const value = el.getAttribute("content");
          if (!value) return;
          if (key === "og:image" || key === "og:image:url") found ??= value;
          else if (key === "twitter:image" || key === "twitter:image:src") twitter ??= value;
        },
      })
      .transform(page)
      .arrayBuffer();
    const src = found ?? twitter;
    if (!src) return null;
    const url = new URL(src, page.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const image = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const type = image.headers.get("content-type") ?? "";
    if (!image.ok || !/^image\/(png|jpe?g|webp|gif|avif)/.test(type)) return null;
    const body = await image.arrayBuffer();
    return body.byteLength && body.byteLength <= MAX_BYTES ? { body, type } : null;
  } catch {
    return null;
  }
}
