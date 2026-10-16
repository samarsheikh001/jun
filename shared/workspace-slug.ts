// D-96: each workspace has a slug for its desk URLs (/w/<slug>/inbox). Made once from the name
// and kept when the workspace is renamed, so links keep working.

export const MAX_SLUG = 40;

/** "Acme Support (EU)" → "acme-support-eu"; nothing usable → "workspace". */
export function slugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return slug || "workspace";
}

/** `base`, else `base-2`, `base-3`… (shortened to fit), whichever no other workspace has. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(slug)) return slug;
  }
}

/** The part of a slug `uniqueSlug` never shortens: workspaces that start with it are the ones that can clash. */
export const slugStem = (base: string): string => base.slice(0, MAX_SLUG - 6);
