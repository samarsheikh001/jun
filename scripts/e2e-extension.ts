// E2E for Jun for Chrome (E-01): loads a test build of extension/ into a real Chrome (its own
// throwaway profile, DevTools Protocol over a pipe, Extensions.loadUnpacked), opens
// scripts/e2e-extension-page.html (a strict CSP, a password field, a [data-jun-private] block) and
// drives the content script the way the side panel does: inject, list tools, read (masked and not),
// point, type, choose, click. No AI is called. Run: node scripts/e2e-extension.ts
// (CHROME_PATH to pick the browser; it builds extension/dist-test first).
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "extension", "dist-test", "chrome-mv3");

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome found: set CHROME_PATH");
  return found;
}

// ---------- DevTools Protocol over --remote-debugging-pipe ----------
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
class Cdp {
  #id = 0;
  #pending = new Map<number, Pending>();
  #buffer = "";
  #out: Writable;
  constructor(out: Writable, input: Readable) {
    this.#out = out;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let end: number;
      while ((end = this.#buffer.indexOf("\0")) >= 0) {
        const msg = JSON.parse(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 1);
        const p = msg.id !== undefined ? this.#pending.get(msg.id) : undefined;
        if (!p) continue;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        else p.resolve(msg.result);
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.#id;
    this.#out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  /** Runs an expression in a target and returns its (awaited) value. */
  async eval<T>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✖ ${name}\n  ${e instanceof Error ? e.message : e}`);
  }
}

// ---------- run ----------
console.log("Building the test extension…");
execSync("npx wxt build", { cwd: join(ROOT, "extension"), env: { ...process.env, JUN_EXT_TEST: "1" }, stdio: "ignore" });
assert.ok(existsSync(join(OUT, "manifest.json")), "no test build");

const html = readFileSync(join(ROOT, "scripts", "e2e-extension-page.html"));
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings?token=abc123`;

const profile = mkdtempSync(join(tmpdir(), "jun-ext-e2e-"));
const chrome = spawn(
  chromePath(),
  [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const cdp = new Cdp(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);

try {
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: OUT });
  console.log(`Loaded extension ${extId}`);

  const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: PAGE });
  const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
  await until("the page", () => cdp.eval<boolean>(page, "document.readyState === 'complete' && !!document.getElementById('save')"));

  // The extension's service worker has chrome.tabs / chrome.scripting, like the side panel.
  const worker = await until("the service worker", async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find((t: { type: string; url: string }) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
  });
  const { sessionId: sw } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const tabId = await until("the tab", () => cdp.eval<number>(sw, `chrome.tabs.query({}).then((t) => t.find((x) => x.url && x.url.startsWith(${JSON.stringify(PAGE.split("?")[0])}))?.id)`));

  /** What the side panel's callPage does: inject (idempotent), then one message. */
  const call = (request: object) =>
    cdp.eval<{ ok: boolean; result?: any; error?: string }>(
      sw,
      `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["/content-scripts/page.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(request)}))`,
    );
  const onPage = <T>(expr: string) => cdp.eval<T>(page, expr);
  let read: any;
  const indexOf = (pattern: RegExp) => {
    const line = String(read.content).split("\n").find((l: string) => pattern.test(l));
    const m = line && /\[(\d+)\]/.exec(line);
    assert.ok(m, `no element matching ${pattern} in:\n${read.content}`);
    return Number(m[1]);
  };

  await step("lists six tools: the five page actions and point_at; reading and pointing don't ask", async () => {
    const r = await call({ type: "jun:tools" });
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.result.map((t: { name: string; risk: string }) => `${t.name}:${t.risk}`), ["read_page:auto", "click:confirm", "type_text:confirm", "choose_option:confirm", "scroll_page:auto", "point_at:auto"]);
  });

  await step("read_page (masked): no email, no URL token, no password or private block, under a strict CSP", async () => {
    const r = await call({ type: "jun:run", name: "read_page", input: {}, mask: true });
    assert.ok(r.ok, r.error);
    read = r.result;
    const all = JSON.stringify(read);
    assert.ok(all.includes("Save changes") && all.includes("Account settings"), all);
    assert.ok(!all.includes("jane@example.com"), "email leaked");
    assert.ok(!all.includes("abc123"), "URL token leaked");
    assert.ok(!all.includes("hunter2") && !all.includes("123-45-6789") && !all.includes("Delete everything"), "private part leaked");
  });

  await step("read_page (unmasked): the page's text as it is, private parts still never read", async () => {
    const r = await call({ type: "jun:run", name: "read_page", input: {}, mask: false });
    assert.ok(r.ok, r.error);
    read = r.result;
    const all = JSON.stringify(read);
    if (process.env.SHOW_READ) console.log(read.content);
    assert.ok(all.includes("jane@example.com"), "unmasked read should keep the email");
    assert.ok(read.url.includes("token=abc123"), read.url);
    assert.ok(!all.includes("hunter2") && !all.includes("123-45-6789") && !all.includes("Delete everything"), "private part leaked");
  });

  await step("point_at rings the element with its note (a private, click-through layer)", async () => {
    const r = await call({ type: "jun:run", name: "point_at", input: { index: indexOf(/Save changes/), note: "Click here to save", label: "Save changes" } });
    assert.ok(r.ok, r.error);
    assert.match(String(r.result), /Showing Save changes/);
    assert.ok(await onPage<boolean>("[...document.querySelectorAll('[data-jun-private]')].some((el) => el.shadowRoot === null && el.parentElement === document.documentElement)"), "no pointer layer");
    await wait(450); // the ring fades in
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
    const file = join(tmpdir(), "jun-ext-point.png");
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`  screenshot: ${file}`);
  });

  await step("type_text and choose_option change the page", async () => {
    const t = await call({ type: "jun:run", name: "type_text", input: { index: indexOf(/<input name=name/), text: "Jane Doe", label: "Display name" } });
    assert.ok(t.ok, t.error);
    const c = await call({ type: "jun:run", name: "choose_option", input: { index: indexOf(/<select id=plan/), option: "team", label: "Plan" } });
    assert.ok(c.ok, c.error);
    assert.equal(await onPage<string>("document.getElementById('name').value"), "Jane Doe");
    assert.equal(await onPage<string>("document.getElementById('plan').value"), "Team");
  });

  await step("click runs the page's own handler", async () => {
    const r = await call({ type: "jun:run", name: "click", input: { index: indexOf(/Save changes/), label: "Save changes" } });
    assert.ok(r.ok, r.error);
    await until("the click's effect", () => onPage<boolean>("document.getElementById('status').textContent === 'Saved as Jane Doe on Team'"), 5000);
  });

  await step("a number the read never gave is refused; unknown messages are ignored", async () => {
    const r = await call({ type: "jun:run", name: "click", input: { index: 999 } });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /no element 999/);
    const odd = await cdp.eval<unknown>(sw, `chrome.tabs.sendMessage(${tabId}, { type: "jun:eval", code: "1" }).then((x) => x ?? "none", () => "none")`);
    assert.equal(odd, "none");
  });

  await step("the island: the toolbar button's summon puts the widget's island on the page; it opens on the content script's word", async () => {
    // What the background does on a toolbar click (its tab list, then the content script and a summon).
    await cdp.eval(sw, `chrome.storage.session.set({ "jun.tabs": [${tabId}] }).then(() => chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["/content-scripts/page.js"] })).then(() => chrome.tabs.sendMessage(${tabId}, { type: "jun:summon", open: false }))`);
    await until("the island frame", () => onPage<boolean>(`(() => { const f = document.querySelector('[data-jun-desk="extension"]')?.shadowRoot?.querySelector("iframe"); return !!f && f.style.clipPath.includes("calc"); })()`), 15000);
    const island = await until("the island page", async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.find((t: { url: string }) => t.url.startsWith(`chrome-extension://${extId}/island.html`));
    });
    const { sessionId: frame } = await cdp.send("Target.attachToTarget", { targetId: island.targetId, flatten: true });
    await until("the resting pill", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-rest')"));
    // A read never sees the island (it's under [data-jun-desk]).
    const r = await call({ type: "jun:run", name: "read_page", input: {}, mask: true });
    assert.ok(r.ok && !JSON.stringify(r.result).includes("Ask about this page"), "the read saw the island");
    await wait(900);
    const shots: string[] = [];
    const shoot = async (name: string) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
      const file = join(tmpdir(), `jun-ext-${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      shots.push(file);
    };
    await shoot("island-rest");
    // "/" on the page opens it (as the widget's).
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "/", text: "/" }, page);
    await until("the open island", () => cdp.eval<boolean>(frame, "!!document.querySelector('.i-open .composer')"));
    await wait(900);
    await shoot("island-open");
    // Not signed in: it offers Sign in with ChatGPT, not a dead end.
    assert.ok(await cdp.eval<boolean>(frame, "[...document.querySelectorAll('.i-foot button')].some((b) => b.textContent === 'Sign in with ChatGPT')"));
    console.log(`  screenshots: ${shots.join(", ")}`);
  });

  await step("Sign in with ChatGPT: the extension sees the sign-in tab reach the 127.0.0.1 callback (nothing listens there)", async () => {
    const url = await cdp.eval<string>(
      sw,
      `new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no callback URL seen")), 8000);
        chrome.tabs.create({ url: "about:blank" }).then((tab) => {
          chrome.tabs.onUpdated.addListener(function seen(id, change) {
            if (id !== tab.id || !change.url || !change.url.startsWith("http://127.0.0.1:1455/auth/callback")) return;
            chrome.tabs.onUpdated.removeListener(seen);
            clearTimeout(timer);
            chrome.tabs.remove(id);
            resolve(change.url);
          });
          chrome.tabs.update(tab.id, { url: "http://127.0.0.1:1455/auth/callback?code=c1&state=s1&client_id=app_x" });
        });
      })`,
    );
    assert.equal(new URL(url).searchParams.get("client_id"), "app_x");
  });

  await step("nothing of the page tools' is left in the page's own world", async () => {
    assert.equal(await onPage<string>("typeof window.__junExtension"), "undefined");
  });
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

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll extension checks passed.");
