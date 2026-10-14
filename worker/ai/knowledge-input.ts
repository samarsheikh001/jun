import { MAX_KB_FILE_BYTES } from "../../shared/protocol.ts";

// D-87: pure input rules for knowledge added outside the Knowledge page's upload (the MCP's
// add_document), and the plain words the MCP uses for a source's type and state. The upload route
// and add_document share cleanFileName and TOO_LARGE, so both refuse the same files the same way.

export const TOO_LARGE = `Files are limited to ${MAX_KB_FILE_BYTES / 1024 / 1024} MB.`;
export const MAX_DOCUMENT_NAME = 200;

/** A file name safe for storage and Content-Disposition (as the upload route cleans X-File-Name). */
export const cleanFileName = (name: string) => name.replace(/[\\/\r\n"\0]/g, "_").trim().slice(0, 200);

export class DocumentInputError extends Error {}

export interface DocumentInput {
  /** The source's title in the Knowledge list. */
  title: string;
  /** The stored file's name: its extension picks how it's read (.md for text). */
  fileName: string;
  bytes: Uint8Array;
}

const fail = (message: string): never => {
  throw new DocumentInputError(message);
};

/**
 * add_document's arguments → a file for the same path as an upload. `name` plus exactly one of `text`
 * (plain text or Markdown, stored as a .md file) or `base64` with `filename` (whatever the upload takes:
 * the extension and bytes are checked by sniffFormat when it's added). Same size limit as an upload.
 */
export function documentInput(args: Record<string, unknown>): DocumentInput {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) fail("name is required: the document's title in the Knowledge list.");
  if (name.length > MAX_DOCUMENT_NAME) fail(`name is at most ${MAX_DOCUMENT_NAME} characters.`);
  const hasText = args.text !== undefined && args.text !== null;
  const hasFile = args.base64 !== undefined && args.base64 !== null;
  if (hasText === hasFile) fail("Pass either text (plain text or Markdown) or base64 with filename (a file), not both.");

  if (hasText) {
    if (typeof args.text !== "string" || !args.text.trim()) fail("text is empty.");
    const bytes = new TextEncoder().encode(args.text as string);
    if (bytes.byteLength > MAX_KB_FILE_BYTES) fail(TOO_LARGE);
    const base = cleanFileName(name).replace(/\.(md|markdown|txt)$/i, "").slice(0, 190) || "document";
    return { title: name, fileName: `${base}.md`, bytes };
  }

  const fileName = typeof args.filename === "string" ? cleanFileName(args.filename) : "";
  if (!fileName) fail("filename is required with base64, like guide.pdf: its extension says what the file is.");
  if (typeof args.base64 !== "string") fail("base64 must be a string.");
  // A data: URL's prefix and line breaks are fine; URL-safe base64 too.
  const data = (args.base64 as string).replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!data) fail("base64 is empty.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || (data.endsWith("=") && data.length % 4 !== 0)) fail("base64 isn't valid base64.");
  // Checked before decoding, so an oversized file is never held twice.
  const size = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > MAX_KB_FILE_BYTES) fail(TOO_LARGE);
  let binary: string;
  try {
    binary = atob(data.length % 4 ? data + "=".repeat(4 - (data.length % 4)) : data);
  } catch {
    return fail("base64 isn't valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength > MAX_KB_FILE_BYTES) fail(TOO_LARGE);
  return { title: name, fileName, bytes };
}

export type SourceKind = "website" | "snippet" | "file";
export type SourceState = "queued" | "crawling" | "indexing" | "ready" | "failed";

/** The stored status in the MCP's words: a website crawls, a file or text is indexed. */
export function sourceState(kind: SourceKind, status: string): SourceState {
  if (status === "ready") return "ready";
  if (status === "error") return "failed";
  if (status === "syncing") return kind === "website" ? "crawling" : "indexing";
  return "queued";
}

/** website (a crawl), page (a website source capped at one page), file, or text (a snippet written on the desk). */
export function sourceType(kind: SourceKind, maxPages: number | null): "website" | "page" | "file" | "text" {
  if (kind === "website") return maxPages === 1 ? "page" : "website";
  return kind === "file" ? "file" : "text";
}
