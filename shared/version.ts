// T-17: this build's version, and where new versions come from. `npm run release` bumps the
// version here and in package.json together (shared/version.test.ts checks they match); pushing
// the tag makes the GitHub Release that installs update to (.github/workflows/update-jun.yml).

export const JUN_VERSION = "0.1.0";

/** The GitHub repo releases come from. */
export const JUN_UPSTREAM = "samarsheikh001/jun";

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; null when it isn't a plain x.y.z version. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, 0 when equal, positive when newer. Unreadable versions count as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The next version for `npm run release -- patch|minor|major|x.y.z`. */
export function nextVersion(current: string, bump: string): string {
  const exact = parseVersion(bump);
  if (exact) return exact.join(".");
  const [major, minor, patch] = parseVersion(current) ?? [0, 0, 0];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown version bump "${bump}": use patch, minor, major or x.y.z`);
}
