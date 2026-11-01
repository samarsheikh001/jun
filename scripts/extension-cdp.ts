// Driving a real Chrome with Jun for Chrome loaded (E-01): DevTools Protocol over --remote-debugging-pipe,
// shared by scripts/e2e-extension.ts and scripts/extension-store-shots.ts.
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

export function chromePath(): string {
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
export class Cdp {
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

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}

