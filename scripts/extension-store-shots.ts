// Chrome Web Store images for Jun for Chrome (E-01): three 1280×800 screenshots of the island on a
// made-up app (extension/store/demo-page.html) and the 440×280 promo tile (extension/store/promo-tile.html),
// written to extension/store/. The answer is a saved chat (no AI is called); the ring is the real point_at.
// Run: node scripts/extension-store-shots.ts
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Cdp, chromePath, until, wait } from "./extension-cdp.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STORE = join(ROOT, "extension", "store");
const OUT = join(ROOT, "extension", "dist-test", "chrome-mv3");

console.log("Building the test extension…");
execSync("npx wxt build", { cwd: join(ROOT, "extension"), env: { ...process.env, JUN_EXT_TEST: "1" }, stdio: "ignore" });

const html = readFileSync(join(STORE, "demo-page.html"));
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings/billing`;

const profile = mkdtempSync(join(tmpdir(), "jun-ext-shots-"));
const chrome = spawn(chromePath(), ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--headless=new", "--hide-scrollbars", "about:blank"], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
});
const cdp = new Cdp(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);

const save = async (session: string, name: string) => {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  writeFileSync(join(STORE, name), Buffer.from(shot.data, "base64"));
  console.log(`  ${join("extension", "store", name)}`);
};

try {
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: OUT });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);
  await cdp.send("Page.navigate", { url: PAGE }, page);
  await until("the page", () => cdp.eval<boolean>(page, "document.readyState === 'complete' && !!document.getElementById('download')"));

  const worker = await until("the service worker", async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find((t: { type: string; url: string }) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
  });
  const { sessionId: sw } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const tabId = await until("the tab", () => cdp.eval<number>(sw, `chrome.tabs.query({}).then((t) => t.find((x) => x.url && x.url.startsWith(${JSON.stringify(PAGE)}))?.id)`));
  const call = (request: object) => cdp.eval<{ ok: boolean; result?: any }>(sw, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["/content-scripts/page.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(request)}))`);

  // Signed in, as a person using it would be (only the island's "ready" check reads this).
  await cdp.eval(sw, `chrome.storage.local.set({ "jun.chatgpt": { hostId: "urn:uuid:shots", clientId: "app_shots", tokens: { accessToken: "x", refreshToken: "x", expiresAt: ${Date.now() + 3_600_000}, email: "you@example.com" } } })`);
  await cdp.eval(sw, `chrome.storage.session.set({ "jun.tabs": [${tabId}] })`);
  await call({ type: "jun:summon", open: false });
  const islandFrame = async () => {
    const t = await until("the island page", async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.find((x: { url: string }) => x.url.startsWith(`chrome-extension://${extId}/island.html`));
    });
    return (await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId as string;
  };
  let frame = await islandFrame();
  await until("the resting pill", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-rest')"));
  await wait(2500); // the pill types a suggestion out
  await save(page, "screenshot-1-rest.png");

  await call({ type: "jun:summon", open: true });
  await until("the open island", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-open .i-chips')"));
  await wait(900);
  await save(page, "screenshot-2-ask.png");

  // An answer that shows where: a saved chat, and the real ring on the button.
  const chat = {
    exchanges: [
      {
        id: "x1",
        question: "How do I download my invoices?",
        text: "Your invoices are in the **Invoices** card on this Billing page.\n\n1. Click **Download all invoices** (I've marked it) to get every invoice at once.\n2. Or click **PDF** next to a single month.",
        streaming: false,
        error: null,
        at: Date.now(),
        actions: [
          { runId: "r1", id: "r1", name: "read_page", description: "Read", risk: "auto", params: {}, required: [], input: {}, missing: [], status: "ok", result: null, canUndo: false, statusLine: "Reading the page" },
          { runId: "r2", id: "r2", name: "point_at", description: "Point", risk: "auto", params: {}, required: [], input: { label: "Download all invoices" }, missing: [], status: "ok", result: "Showing Download all invoices", canUndo: false, statusLine: "Pointing" },
        ],
      },
    ],
    history: [],
  };
  await cdp.eval(sw, `chrome.storage.session.set({ "jun.chat.${tabId}": ${JSON.stringify(chat)} })`);
  await cdp.eval(frame, "setTimeout(() => location.reload(), 50)");
  await wait(800);
  frame = await islandFrame();
  await until("the restored chat", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-rest')"));
  await call({ type: "jun:summon", open: true });
  await until("the answer", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-answer .msg.ai')"));
  const read = await call({ type: "jun:run", name: "read_page", input: {}, mask: true });
  const line = String(read.result.content).split("\n").find((l: string) => /Download all invoices/.test(l))!;
  const index = Number(/\[(\d+)\]/.exec(line)![1]);
  await call({ type: "jun:run", name: "point_at", input: { index, note: "Download all invoices here", label: "Download all invoices" } });
  await wait(1200);
  await save(page, "screenshot-3-guide.png");

  // The promo tile.
  const { targetId: tileTarget } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: tile } = await cdp.send("Target.attachToTarget", { targetId: tileTarget, flatten: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 440, height: 280, deviceScaleFactor: 1, mobile: false }, tile);
  await cdp.send("Page.navigate", { url: pathToFileURL(join(STORE, "promo-tile.html")).href }, tile);
  await until("the tile", () => cdp.eval<boolean>(tile, "document.readyState === 'complete' && document.fonts.status === 'loaded'"));
  await wait(300);
  await save(tile, "promo-tile-440x280.png");
} finally {
  chrome.kill();
  server.close();
  await wait(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a file on Windows
  }
}
