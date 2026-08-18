// Somebody has to commit the worker's work, and until defect 30 nobody did.
//
// A code worker writes files in its worktree and its branch tip stays on the base
// commit. Verification then passes — it runs against the dirty worktree, so the work
// is right there — the merge merges a branch with no commits, reports `merged` with a
// result sha identical to the base, and the worktree is removed. Verified work, gone,
// with a green log behind it. That happened twice on one real mission.
//
// So the commit is the runtime's job, not an instruction in a prompt a worker may
// ignore: `git add -A` and a commit naming the task, run in the worktree before the
// lease check has anything to read and before verification decides anything.
//
// Three outcomes rather than a boolean, because "nothing changed" and "git refused"
// are different facts about the mission and collapsing them is how a repo with no
// configured identity reads as a worker that did nothing.
import { git, tryGit } from "./repo.js";

export type CommitOutcome =
  | { status: "committed"; sha: string; files: string[] }
  /** The worker changed nothing, or committed its own work already. */
  | { status: "empty" }
  | { status: "failed"; message: string };

export async function commitWorktree(
  worktree: string,
  message: string,
): Promise<CommitOutcome> {
  const staged = await tryGit(worktree, ["add", "-A"]);
  if (!staged.ok) {
    return {
      status: "failed",
      message:
        `Could not stage the worker's changes in ${worktree}: ${staged.stderr}. ` +
        `Fix the worktree by hand — its contents are left in place.`,
    };
  }

  const pending = await git(worktree, ["diff", "--cached", "--name-only"]);
  const files = pending.split("\n").filter(Boolean);
  if (files.length === 0) return { status: "empty" };

  // `--no-verify` because the mission's own verification (§4) is what decides whether
  // this work is good; a repo hook refusing the commit would instead destroy it.
  const committed = await tryGit(worktree, ["commit", "--no-verify", "-m", message]);
  if (!committed.ok) {
    return {
      status: "failed",
      message:
        `The worker's changes could not be committed in ${worktree}: ` +
        `${committed.stderr || committed.stdout}. Configure git's user.name and ` +
        `user.email in this repository, then re-run the task — the changes are still ` +
        `in the worktree.`,
    };
  }

  return { status: "committed", sha: await git(worktree, ["rev-parse", "HEAD"]), files };
}
