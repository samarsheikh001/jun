// AI-31: what the MCP's previews put in the screenshot page's URL fragment (shot.html, web/shot/):
// a card to draw, or a chat look to show in the real frame. JSON, gzipped, base64url: a card is up
// to 48 KB of JSON and compresses well, and a fragment never reaches a server's logs. Pure (web streams).

import type { WidgetLook } from "./appearance.ts";
import type { WidgetNode } from "./widgets.ts";

export type Shot =
  | { kind: "card"; name: string; root: WidgetNode; theme: "light" | "dark" }
  /** `page`: the colour of the page behind it (the island picks its own from it, D-99). */
  | { kind: "chat"; key: string; look: WidgetLook; open: boolean; page: "light" | "dark" };

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes.slice()]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The fragment for a shot (no leading #). */
export async function writeShot(shot: Shot): Promise<string> {
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(shot)), new CompressionStream("gzip"));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The shot a fragment carries; null for anything else. */
export async function readShot(fragment: string): Promise<Shot | null> {
  try {
    const binary = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const shot = JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream("gzip")))) as Shot;
    if (shot?.kind === "card" && typeof shot.root === "object" && shot.root) return shot;
    if (shot?.kind === "chat" && typeof shot.key === "string" && typeof shot.look === "object" && shot.look) return shot;
    return null;
  } catch {
    return null;
  }
}
