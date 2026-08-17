// Thin, explicit git. Every call takes the repo it operates on rather than reading a
// module-level config, which is what made the old worktree helpers untestable.
import { run } from "../runtime/sh.js";

export class GitError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(stderr.trim() ? `${message}: ${stderr.trim()}` : message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

export async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await run("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed in ${repo}`, result.stderr);
  }
  return result.stdout.trim();
}

/** Like `git`, but a non-zero exit is an answer rather than an error. */
export async function tryGit(
  repo: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await run("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  return { ok: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export const resolveSha = (repo: string, rev: string): Promise<string> =>
  git(repo, ["rev-parse", rev]);

export const currentBranch = (repo: string): Promise<string> =>
  git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const result = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout : undefined;
}

/**
 * A working tree as two comparable measures, for asking whether something changed a
 * directory while it ran there (defect 41).
 *
 * Two measures because one is not enough. The porcelain lines catch a file appearing,
 * vanishing, or changing status; the tracked patch catches a *further* edit to a file
 * that was already dirty, whose status line therefore never moved. Neither catches an
 * edit to the contents of a file that was already untracked before and after — that is
 * the known gap, and closing it would mean hashing every untracked path on every
 * dispatch to catch a case that requires the checkout to be dirty first.
 */
export interface WorkingTree {
  lines: string[];
  patch: string;
}

export async function readWorkingTree(repo: string): Promise<WorkingTree> {
  const status = await git(repo, ["status", "--porcelain"]);
  // `tryGit`, because a repository with no commits has no HEAD to diff against and
  // that is a legitimate state rather than an error.
  const diff = await tryGit(repo, ["diff", "HEAD"]);
  return {
    lines: status ? status.split("\n").filter(Boolean) : [],
    patch: diff.ok ? diff.stdout : "",
  };
}

/** Files changed in a worktree against the commit it was created from. */
export async function changedFiles(worktree: string, baseSha: string): Promise<string[]> {
  const tracked = await git(worktree, ["diff", "--name-only", baseSha]);
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

export async function hasCommitsSince(worktree: string, baseSha: string): Promise<boolean> {
  const log = await git(worktree, ["rev-list", `${baseSha}..HEAD`, "--count"]);
  return Number(log) > 0;
}
