// Worktree isolation for code tasks.
//
// The base commit is pinned by the caller and recorded, never taken from whatever
// HEAD happens to be. The old helper always based on `HEAD` of whatever branch the
// repo was on, so with concurrent merges two tasks dispatched minutes apart silently
// got different bases — and the second one's diff then contained the first one's work.
import fs from "node:fs";
import path from "node:path";
import { git, tryGit } from "./repo.js";

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

const DIR_MODE = 0o700;

/** Branch names are not filesystem names: `feat/health` would nest a directory. */
export const worktreeDirName = (branch: string): string => branch.replace(/[^\w.-]/g, "_");

export async function createWorktree(
  repo: string,
  root: string,
  branch: string,
  baseSha: string,
): Promise<Worktree> {
  fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const dir = path.join(root, worktreeDirName(branch));

  if (fs.existsSync(dir)) {
    throw new Error(
      `Worktree directory ${dir} already exists. Another task is using branch '${branch}', ` +
        `or a previous run left it behind — run 'orchestra doctor' to reconcile.`,
    );
  }

  await git(repo, ["worktree", "add", "-b", branch, dir, baseSha]);
  return { path: dir, branch, baseSha };
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  await tryGit(repo, ["worktree", "remove", "--force", worktree]);
  // `worktree remove` refuses in some states (a missing directory, a locked entry);
  // pruning after the fact is what stops the registry drifting from reality.
  await tryGit(repo, ["worktree", "prune"]);
}

export interface RegisteredWorktree {
  path: string;
  branch?: string;
  head?: string;
}

export async function listWorktrees(repo: string): Promise<RegisteredWorktree[]> {
  const raw = await git(repo, ["worktree", "list", "--porcelain"]);
  const blocks = raw.split("\n\n").filter((block) => block.trim() !== "");

  return blocks.map((block) => {
    const fields = Object.fromEntries(
      block.split("\n").map((line) => {
        const space = line.indexOf(" ");
        return space === -1 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
      }),
    );
    return {
      path: fields.worktree,
      branch: fields.branch?.replace(/^refs\/heads\//, ""),
      head: fields.HEAD,
    };
  });
}

export interface PruneResult {
  removed: string[];
  kept: string[];
}

/**
 * Resolve symlinks before comparing paths.
 *
 * `git worktree list` reports realpaths, so on macOS — where the temp dir and plenty
 * of home directories are symlinked — `/var/…` and `/private/var/…` name the same
 * worktree and compare as different. Without this, an orphan is never recognised as
 * ours and pruning silently does nothing.
 */
function canonical(target: string): string {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    // A path that no longer exists cannot be resolved, and is still worth comparing.
    return path.resolve(target);
  }
}

/**
 * Reconcile the worktree registry against the tasks we know about (§9.3).
 *
 * A backstop, not the primary mechanism: `removeWorktree` runs on task completion.
 * This catches what a crash left behind, and the main repo checkout is never a
 * candidate — it is listed first by git and is not ours to remove.
 */
export async function pruneOrphanWorktrees(
  repo: string,
  root: string,
  keep: readonly string[],
): Promise<PruneResult> {
  const registered = await listWorktrees(repo);
  const keepSet = new Set(keep.map(canonical));
  const rootResolved = canonical(root);

  const removed: string[] = [];
  const kept: string[] = [];

  for (const entry of registered) {
    const resolved = canonical(entry.path);
    const ours = resolved.startsWith(`${rootResolved}${path.sep}`);
    if (!ours || keepSet.has(resolved)) {
      kept.push(entry.path);
      continue;
    }
    await removeWorktree(repo, entry.path);
    removed.push(entry.path);
  }

  return { removed, kept };
}
