// Screenshots and images in Jun for Chrome's island (E-01). "Take a screenshot" captures the visible
// tab through the background (Chrome's tab capture: no screen-share prompt; the island hides for the
// shot); the person sees it before it's sent, as in the widget (S-15). Images go to the person's AI
// with their question, scaled down; the chat keeps a small thumbnail.

/** Longest side sent to the AI. */
const MAX_SIDE = 1600;
/** Longest side of the thumbnail kept in the chat. */
const THUMB_SIDE = 360;

export interface PreparedImage {
  /** Base64 JPEG for the model. */
  base64: string;
  mediaType: "image/jpeg";
  /** A small data URL for the chat. */
  thumb: string;
}

/** The visible tab, without the island, as a File; throws with a line the person can act on. */
export async function captureTab(): Promise<File | null> {
  const r = (await browser.runtime.sendMessage({ type: "jun:shot" }).catch(() => null)) as { ok: true; dataUrl: string } | { ok: false; error: string } | null;
  if (!r) throw new Error("Couldn't take a screenshot. Try again.");
  if (!r.ok) throw new Error(r.error);
  const blob = await (await fetch(r.dataUrl)).blob();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return new File([blob], `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.jpg`, { type: "image/jpeg" });
}

async function draw(bitmap: ImageBitmap, side: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

const base64Of = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** An image file, scaled for the AI and as a thumbnail. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const [full, small] = await Promise.all([draw(bitmap, MAX_SIDE, 0.85), draw(bitmap, THUMB_SIDE, 0.7)]);
    return { base64: await base64Of(full), mediaType: "image/jpeg", thumb: `data:image/jpeg;base64,${await base64Of(small)}` };
  } finally {
    bitmap.close();
  }
}
