import { MAX_KB_FILE_BYTES, MAX_KB_FILES } from "../../shared/protocol.ts";
import { newId } from "../lib/crypto.ts";
import { text } from "../lib/validate.ts";
import { HttpError } from "../types.ts";
import { sniffFormat, UnsupportedFile, type FileFormat } from "./file-extract.ts";
import { DEFAULT_MAX_PAGES, fileKey, indexSnippet, startFileIndex, startSync, type SourceSettings } from "./knowledge.ts";
import { TOO_LARGE } from "./knowledge-input.ts";

// D-87: the Knowledge page's changes as functions, called by its routes (worker/routes/ai.ts) and by
// the MCP's knowledge tools (worker/mcp/tools.ts), so both validate, limit, store and queue the same
// way. Expected failures are HttpErrors (the routes render them; the MCP returns their message).
// Removing a source is deleteSource in knowledge.ts; searching is searchKnowledge in search.ts.

export interface SourceListRow {
  id: string;
  kind: "website" | "snippet" | "file";
  url: string | null;
  title: string;
  status: string;
  pageCount: number;
  pendingJobs: number;
  error: string | null;
  lastSyncedAt: number | null;
  createdAt: number;
  fileName: string | null;
  fileSize: number | null;
  chunkCount: number;
  chunksWithoutVectors: number;
}

/** Every source with its state and counts, newest first (the Knowledge page's list). */
export async function listSources(env: Env, workspaceId: string): Promise<SourceListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, url, title, status, page_count AS pageCount, pending_jobs AS pendingJobs, error, last_synced_at AS lastSyncedAt, created_at AS createdAt,
            json_extract(settings, '$.file.name') AS fileName, json_extract(settings, '$.file.size') AS fileSize,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.source_id = s.id) AS chunkCount,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.source_id = s.id AND k.embedded = 0) AS chunksWithoutVectors
     FROM kb_sources s WHERE workspace_id = ? ORDER BY created_at DESC`,
  )
    .bind(workspaceId)
    .all<SourceListRow>();
  return rows.results;
}

/** Adds a website (or, with maxPages 1, one page) and queues its crawl. `body` is { url, maxPages? }. */
export async function addWebsite(env: Env, workspaceId: string, body: Record<string, unknown>): Promise<{ id: string; title: string; maxPages: number }> {
  let url: URL;
  try {
    url = new URL(text(body, "url", { max: 2000 }));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new HttpError(400, "invalid_field", "Enter a full URL, like https://docs.example.com.");
  }
  const maxPages = Math.min(Math.max(Number(body.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES, 1), 2000);
  const known = await env.DB.prepare("SELECT title FROM kb_sources WHERE workspace_id = ? AND kind = 'website' AND url = ?")
    .bind(workspaceId, url.toString())
    .first<{ title: string }>();
  if (known) throw new HttpError(409, "already_added", `${known.title} is already in your knowledge. Re-sync it there to read it again.`);
  const id = newId("src");
  const title = url.host + (url.pathname === "/" ? "" : url.pathname);
  await env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, url, title, settings, created_at) VALUES (?, ?, 'website', ?, ?, ?, ?)")
    .bind(id, workspaceId, url.toString(), title, JSON.stringify({ maxPages }), Date.now())
    .run();
  await startSync(env, id);
  return { id, title, maxPages };
}

/** Refuses a new file when the workspace has MAX_KB_FILES already (checked before an upload's body is read). */
export async function assertRoomForFile(env: Env, workspaceId: string): Promise<void> {
  const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_sources WHERE workspace_id = ? AND kind = 'file'").bind(workspaceId).first<{ n: number }>())!;
  if (n >= MAX_KB_FILES) throw new HttpError(400, "too_many_files", `A workspace can have up to ${MAX_KB_FILES} files. Remove some first.`);
}

const FILE_CONTENT_TYPES: Record<FileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

/**
 * K-02: a file as a source: the original in R2 (kb/<workspace>/<source>), a `file` Queue job extracts
 * and indexes it. `name` is already cleaned (cleanFileName); its extension and the bytes say the format.
 */
export async function addFileSource(
  env: Env,
  workspaceId: string,
  file: { name: string; title: string; bytes: Uint8Array },
): Promise<{ id: string; title: string; format: FileFormat; size: number }> {
  await assertRoomForFile(env, workspaceId);
  const { name, title, bytes } = file;
  if (bytes.byteLength > MAX_KB_FILE_BYTES) throw new HttpError(400, "too_large", TOO_LARGE);
  let format: FileFormat;
  try {
    format = sniffFormat(name, bytes);
  } catch (error) {
    if (error instanceof UnsupportedFile) throw new HttpError(400, "unsupported_file", error.message);
    throw error;
  }
  const id = newId("src");
  const key = fileKey(workspaceId, id);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: FILE_CONTENT_TYPES[format] } });
  await env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, title, settings, created_at) VALUES (?, ?, 'file', ?, ?, ?)")
    .bind(id, workspaceId, title, JSON.stringify({ file: { key, name, format, size: bytes.byteLength } } satisfies SourceSettings), Date.now())
    .run();
  await startFileIndex(env, id);
  return { id, title, format, size: bytes.byteLength };
}

/** Re-crawls a website, re-indexes a file or a snippet. The source's kind, or null when there's no such source. */
export async function resyncSource(env: Env, workspaceId: string, sourceId: string): Promise<SourceListRow["kind"] | null> {
  const source = await env.DB.prepare("SELECT kind FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(sourceId, workspaceId).first<{ kind: SourceListRow["kind"] }>();
  if (!source) return null;
  if (source.kind === "website") await startSync(env, sourceId);
  else if (source.kind === "file") await startFileIndex(env, sourceId);
  else await indexSnippet(env, sourceId);
  return source.kind;
}
