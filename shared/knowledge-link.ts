// D-139: a knowledge source's own address in the desk, /knowledge/<sourceId> (its details sheet over the
// Knowledge list). Pure; shared by the Worker (the Home assistant's tool results), Home and the Knowledge page.

const SOURCE_ID = /^[\w-]{1,64}$/;

/** A source id as the desk makes them (`src_…`): letters, digits, `_` and `-`. */
export const isSourceId = (v: unknown): v is string => typeof v === "string" && SOURCE_ID.test(v);

/** A source's page; Knowledge itself without a (valid) id. */
export const knowledgeLink = (sourceId?: string | null): string => (isSourceId(sourceId) ? `/knowledge/${sourceId}` : "/knowledge");

/** The source id in a desk path `/knowledge/<id>`, else null. */
export function sourceIdOf(path: string): string | null {
  const m = /^\/knowledge\/([^/?#]+)/.exec(path);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return isSourceId(id) ? id : null;
}
