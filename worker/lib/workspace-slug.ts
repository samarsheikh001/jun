import { slugBase, slugStem, uniqueSlug } from "../../shared/workspace-slug.ts";

// D-96: workspace slugs for desk URLs. Made from the name at creation; workspaces from before
// migration 0017 get theirs on the next /me (`fillSlugs`). The unique index settles races: a
// clash retries with a fresh pick.

const isClash = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/** A slug for `name` that no workspace has yet. */
export async function freeSlug(db: D1Database, name: string): Promise<string> {
  const base = slugBase(name);
  // Only slugs that start like this one can clash (bases are a–z, 0–9 and "-": no LIKE wildcards).
  const rows = await db.prepare("SELECT slug FROM workspaces WHERE slug LIKE ?").bind(`${slugStem(base)}%`).all<{ slug: string }>();
  return uniqueSlug(base, rows.results.map((r) => r.slug));
}

/** Runs `write` with a free slug, picking again if another request took it first. */
export async function withFreeSlug<T>(db: D1Database, name: string, write: (slug: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write(await freeSlug(db, name));
    } catch (e) {
      if (!isClash(e) || attempt >= 4) throw e;
    }
  }
}

/** Gives every workspace without a slug one. */
export async function fillSlugs(db: D1Database): Promise<void> {
  const rows = await db.prepare("SELECT id, name FROM workspaces WHERE slug IS NULL ORDER BY created_at").all<{ id: string; name: string }>();
  for (const w of rows.results) {
    await withFreeSlug(db, w.name, (slug) => db.prepare("UPDATE workspaces SET slug = ? WHERE id = ? AND slug IS NULL").bind(slug, w.id).run());
  }
}

/** A workspace's slug (made now if it has none yet), or null when there's no such workspace. */
export async function workspaceSlug(db: D1Database, workspaceId: string): Promise<string | null> {
  const row = await db.prepare("SELECT slug FROM workspaces WHERE id = ?").bind(workspaceId).first<{ slug: string | null }>();
  if (!row) return null;
  if (row.slug) return row.slug;
  await fillSlugs(db);
  return (await db.prepare("SELECT slug FROM workspaces WHERE id = ?").bind(workspaceId).first<{ slug: string | null }>())?.slug ?? null;
}
