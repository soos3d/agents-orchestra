// Git worktree isolation: each worker gets its own branch + working directory,
// so parallel agents never clobber each other. Merge happens only after review.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { run } from "./sh.js";

export async function createWorktree(branch: string): Promise<string> {
  fs.mkdirSync(config.worktreeRoot, { recursive: true });
  const dir = path.join(config.worktreeRoot, branch.replace(/[^\w.-]/g, "_"));

  // Base the new branch on the repo's current HEAD.
  await run("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: config.targetRepo });
  return dir;
}

export async function diffStat(worktree: string): Promise<string> {
  const r = await run("git", ["-C", worktree, "diff", "--stat", "HEAD"], {});
  return r.stdout.trim() || "(no changes)";
}

// Bring a reviewed worktree's branch back into the target repo's current branch.
export async function mergeBranch(branch: string): Promise<string> {
  const r = await run("git", ["merge", "--no-ff", branch], { cwd: config.targetRepo });
  return r.code === 0 ? `merged ${branch}` : `merge failed: ${r.stderr}`;
}

export async function removeWorktree(worktree: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", worktree], { cwd: config.targetRepo });
}
