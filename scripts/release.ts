// T-17: `npm run release -- patch|minor|major|x.y.z` bumps the version (package.json and
// shared/version.ts), commits and tags it. Pushing the tag (`git push origin main --follow-tags`)
// makes the GitHub Release (.github/workflows/release.yml), and every install's daily Update Jun
// workflow then opens a pull request with it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { JUN_VERSION, nextVersion } from "../shared/version.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const bump = process.argv[2];
if (!bump) throw new Error("usage: npm run release -- patch|minor|major|x.y.z");
if (git("status", "--porcelain")) throw new Error("Commit or stash your changes first: a release is one clean commit.");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("Release from main.");

const version = nextVersion(JUN_VERSION, bump);
if (git("tag", "--list", `v${version}`)) throw new Error(`v${version} already exists.`);

const pkg = readFileSync("package.json", "utf8");
writeFileSync("package.json", pkg.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
const shared = readFileSync("shared/version.ts", "utf8");
writeFileSync("shared/version.ts", shared.replace(/(export const JUN_VERSION = )"[^"]*"/, `$1"${version}"`));

git("add", "package.json", "shared/version.ts");
git("commit", "-q", "-m", `release: v${version}`);
git("tag", "-a", `v${version}`, "-m", `Jun v${version}`);
console.log(`Tagged v${version}. Publish it with:\n\n  git push origin main --follow-tags\n`);
