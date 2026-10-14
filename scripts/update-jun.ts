// T-17: update a copy of Jun to the latest release, as a pull request. Run by
// .github/workflows/update-jun.yml (daily, or by hand) from the *new* release's checkout, so the
// newest version of this script always does the update:
//
//   node <release>/scripts/update-jun.ts --new <release dir> --tag v0.2.0 --upstream samarsheikh001/jun
//
// in the copy's checkout. It merges every file three ways (scripts/update-lib.ts), commits the result
// to the `jun-update` branch (force-pushed, so a newer release updates the same pull request) and
// opens or updates the pull request. Needs GITHUB_TOKEN and GITHUB_REPOSITORY (Actions sets both).
// `--dry-run` merges into the working tree and stops before git and GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compareVersions, parseVersion } from "../shared/version.ts";
import { decideFile, isWorkflowFile, pullRequestBody, type MergeText } from "./update-lib.ts";

const BRANCH = "jun-update";
const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const newDir = arg("new") ?? "";
const tag = arg("tag") ?? "";
const upstream = arg("upstream") ?? "samarsheikh001/jun";
const dryRun = process.argv.includes("--dry-run");
/** Testing: the copy's release from a folder instead of GitHub. */
const baseOverride = arg("base");
if (!newDir || !parseVersion(tag)) throw new Error("usage: update-jun.ts --new <dir> --tag vX.Y.Z [--upstream owner/repo] [--dry-run]");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function main() {
  // Which release this copy is on: package.json's version (copies from before versions have none).
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
  const current = pkg.version && parseVersion(pkg.version) ? pkg.version : null;
  if (current && compareVersions(current, tag) >= 0) {
    console.log(`Up to date: this copy is on ${current}, the latest release is ${tag}.`);
    return;
  }

  /** A release's files, from GitHub's tarball; null when it can't be fetched. */
  function download(ref: string): string | null {
    const dir = mkdtempSync(join(tmpdir(), "jun-"));
    const url = `https://codeload.github.com/${upstream}/tar.gz/refs/tags/${ref}`;
    const ok = spawnSync("sh", ["-c", `curl -fsSL "${url}" | tar xz -C "${dir}" --strip-components=1`], { stdio: "inherit" }).status === 0;
    return ok ? dir : null;
  }

  function walk(root: string): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) visit(full);
        else out.push(relative(root, full).split("\\").join("/"));
      }
    };
    visit(root);
    return out;
  }

  const read = (root: string | null, path: string) => {
    if (!root) return null;
    const full = join(root, path);
    return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
  };

  const scratch = mkdtempSync(join(tmpdir(), "jun-merge-"));
  const mergeText: MergeText = (ours, base, theirs) => {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(scratch, n));
    writeFileSync(o!, ours);
    writeFileSync(b!, base);
    writeFileSync(t!, theirs);
    const result = spawnSync("git", ["merge-file", "-p", "-L", "your copy", "-L", `Jun ${current ?? "(unknown)"}`, "-L", `Jun ${tag}`, o!, b!, t!], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if ((result.status ?? -1) < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
    return { text: result.stdout, conflict: (result.status ?? 0) > 0 };
  };

  const baseDir = baseOverride ?? (current ? download(`v${current}`) : null);
  if (current && !baseDir) console.log(`Couldn't fetch v${current}: every file will match ${tag} (resource names kept).`);

  const ours = git("ls-files", "-z").split("\0").filter(Boolean);
  const paths = [...new Set([...ours, ...walk(newDir), ...(baseDir ? walk(baseDir) : [])])].sort();
  const conflicts: string[] = [];
  const remarks: [string, string][] = [];
  const workflows: string[] = [];

  for (const path of paths) {
    const theirs = read(newDir, path);
    const mine = read(".", path);
    if (isWorkflowFile(path)) {
      // Only workflows this copy runs (release.yml is the Jun repo's own), and this updater.
      const used = mine !== null || path === ".github/workflows/update-jun.yml";
      if (used && theirs && !(mine && Buffer.from(mine).equals(Buffer.from(theirs)))) workflows.push(path);
      continue;
    }
    const decision = decideFile(path, read(baseDir, path), mine, theirs, mergeText);
    if (decision.action === "write") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, decision.content);
      if (decision.conflict) conflicts.push(path);
      if (decision.note) remarks.push([path, decision.note]);
    } else if (decision.action === "delete") {
      rmSync(path);
    } else if (decision.note) {
      remarks.push([path, decision.note]);
    }
  }

  const body = pullRequestBody({ from: current, to: tag, upstream, notes: await releaseNotes(), conflicts, remarks, workflows });
  if (dryRun) {
    console.log(body);
    return;
  }

  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("checkout", "-B", BRANCH);
  git("add", "-A");
  if (!git("status", "--porcelain")) {
    console.log(`Nothing to change for ${tag}.`);
    return;
  }
  git("commit", "-q", "-m", `Update Jun to ${tag}`);
  git("push", "-f", "origin", BRANCH);

  await openPullRequest(`Update Jun to ${tag}`, body);
}

await main();

async function releaseNotes(): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${upstream}/releases/tags/${tag}`, { headers: headers() });
    return res.ok ? ((await res.json()) as { body?: string }).body ?? "" : "";
  } catch {
    return "";
  }
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return { accept: "application/vnd.github+json", "user-agent": "jun-update", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** One pull request from jun-update, updated in place. Without permission to open one: an issue instead. */
async function openPullRequest(title: string, text: string) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY isn't set");
  const api = (path: string, init?: RequestInit) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { ...headers(), "content-type": "application/json" } });
  const owner = repo.split("/")[0];
  const open = (await (await api(`/pulls?state=open&head=${owner}:${BRANCH}`)).json()) as { number: number; html_url: string }[];
  if (open[0]) {
    await api(`/pulls/${open[0].number}`, { method: "PATCH", body: JSON.stringify({ title, body: text }) });
    console.log(`Updated ${open[0].html_url}`);
    await closeFallbackIssue(open[0].html_url);
    return;
  }
  const base = git("remote", "show", "origin").match(/HEAD branch: (.+)/)?.[1] ?? "main";
  const created = await api("/pulls", { method: "POST", body: JSON.stringify({ title, body: text, head: BRANCH, base }) });
  if (created.ok) {
    const url = ((await created.json()) as { html_url: string }).html_url;
    console.log(`Opened ${url}`);
    await closeFallbackIssue(url);
    return;
  }
  // "GitHub Actions is not permitted to create or approve pull requests" (a repo setting, off by default).
  console.log(`Couldn't open the pull request (${created.status}): opening an issue with the link instead.`);
  const compare = `https://github.com/${repo}/compare/${base}...${BRANCH}?expand=1`;
  const issueText = `The \`${BRANCH}\` branch has ${title.replace("Update Jun to", "Jun")} ready. [Open the pull request](${compare}) and merge it to update.\n\nTo let this workflow open the pull request itself next time: **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**.\n\n${text}`;
  const existing = await fallbackIssue();
  const res = existing
    ? await api(`/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ title, body: issueText }) })
    : await api("/issues", { method: "POST", body: JSON.stringify({ title, body: issueText }) });
  if (!res.ok) throw new Error(`Couldn't open the pull request or an issue (${res.status}). The update is on the ${BRANCH} branch: ${compare}`);
  console.log(`Issue: ${((await res.json()) as { html_url: string }).html_url}`);

  /** The open "Update Jun to …" issue this workflow opened when it couldn't open a pull request. */
  async function fallbackIssue() {
    const issues = (await (await api(`/issues?state=open&creator=github-actions%5Bbot%5D`)).json()) as { number: number; title: string; pull_request?: unknown }[];
    return issues.find((i) => !i.pull_request && i.title.startsWith("Update Jun to"));
  }

  /** Once the pull request exists, an earlier fallback issue has done its job. */
  async function closeFallbackIssue(pullUrl: string) {
    const issue = await fallbackIssue();
    if (!issue) return;
    await api(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: `The update is now a pull request: ${pullUrl}` }) });
    await api(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  }
}
