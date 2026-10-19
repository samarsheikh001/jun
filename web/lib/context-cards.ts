// D-134: the Context Cards' excerpt: a few lines of a knowledge passage around the first words of the
// question it matched, the words marked. Pure (web/home/ContextCards.tsx draws it).

const STOP = new Set("a an and are as at be but by can do does for from how i if in is it its me my of on or our so that the this to was we what when where which who why will with you your".split(" "));

/** The question's words worth marking (3+ letters, not the small ones). */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/** Up to `max` characters of `text` around the first matched word, as parts with `match` set on the words to mark. */
export function excerpt(text: string, query: string, max = 220): { text: string; match: boolean }[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = queryWords(query);
  const lower = clean.toLowerCase();
  const first = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  let start = first === undefined || first < max / 3 ? 0 : first - Math.floor(max / 3);
  if (start > 0) start = clean.indexOf(" ", start) + 1 || start;
  let piece = clean.slice(start, start + max);
  if (start + max < clean.length) piece = `${piece.replace(/\s+\S*$/, "")}…`;
  if (start > 0) piece = `…${piece}`;
  if (!words.length) return [{ text: piece, match: false }];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return piece.split(re).filter(Boolean).map((part) => ({ text: part, match: words.includes(part.toLowerCase()) }));
}

/** A website passage's domain ("docs.acme.com"), or null. */
export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
