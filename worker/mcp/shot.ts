import { writeShot, type Shot } from "../../shared/shot.ts";

// AI-31: pictures for the MCP's previews. Browser Run's screenshot Quick Action loads the desk's own
// /shot page (shot.html) with the shot in its URL fragment and returns a PNG of it, so the AI sees the
// card or the chat as a customer would. No API token: the Worker's BROWSER binding. Optional: a desk
// without the binding, one on this computer (the browser runs at Cloudflare and can't reach it), or a
// failed shot gets the reason instead, and the tool still answers with its text.

export type ShotResult = { image: { data: string; mimeType: string } } | { skipped: string };

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

export async function screenshot(env: Env, origin: string, shot: Shot, size: { width: number; height: number; selector?: string }): Promise<ShotResult> {
  if (!(env as Partial<Env>).BROWSER) return { skipped: "this desk has no Browser Run binding (BROWSER in wrangler.jsonc), so there's no picture" };
  if (LOCAL.test(new URL(origin).hostname)) return { skipped: "the desk runs on this computer, which Cloudflare's browser can't reach; the deployed desk shows a picture" };
  try {
    const response = await env.BROWSER.quickAction("screenshot", {
      // /shot.html redirects to /shot (the assets' html handling); the fragment stays in the browser.
      url: `${origin}/shot#${await writeShot(shot)}`,
      viewport: { width: size.width, height: size.height, deviceScaleFactor: 2 },
      gotoOptions: { waitUntil: "networkidle0", timeout: 20_000 },
      waitForSelector: { selector: "html[data-ready]", timeout: 15_000 },
      ...(size.selector ? { selector: size.selector } : {}),
      screenshotOptions: { type: "png" },
    });
    if (!response.ok) return { skipped: `the screenshot failed (${response.status}: ${(await response.text()).slice(0, 200)})` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { image: { data: btoa(binary), mimeType: "image/png" } };
  } catch (error) {
    return { skipped: `the screenshot failed (${(error as Error).message || "Browser Run didn't answer"})` };
  }
}
