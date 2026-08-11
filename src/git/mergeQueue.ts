// Merges are serialized and never merge into "whatever branch the repo is on".
//
// Three failures the old `merge_task` had, all silent: it merged into the current
// branch whatever that was, it took no lock so two concurrent merges interleaved,
// and a conflict left the repo mid-merge with the string "merge failed" as the only
// record. Each one is answered below.
import { git, resolveSha, tryGit } from "./repo.js";

export type MergeOutcome =
  | { status: "merged"; branch: string; resultSha: string }
  | { status: "conflicted"; branch: string; files: string[]; message: string }
  | { status: "base_moved"; branch: string; expected: string; actual: string; message: string }
  /** The branch carries no commits, so there is nothing to merge (defect 31). */
  | { status: "empty"; branch: string; message: string };

export interface MergeRequest {
  branch: string;
  into: string;
  /** The sha the caller believes `into` is at. A merge that finds otherwise stops. */
  expectedBaseSha: string;
}

export interface MergeQueue {
  merge(request: MergeRequest): Promise<MergeOutcome>;
  /** Depth including the merge in flight — surfaced so a stuck queue is visible. */
  readonly pending: number;
}

async function conflictedFiles(repo: string): Promise<string[]> {
  const raw = await tryGit(repo, ["diff", "--name-only", "--diff-filter=U"]);
  return raw.stdout.split("\n").filter(Boolean);
}

async function performMerge(repo: string, request: MergeRequest): Promise<MergeOutcome> {
  const { branch, into, expectedBaseSha } = request;

  await git(repo, ["checkout", into]);

  // Assert the base rather than assume it. If `into` moved since this task was
  // planned, its worktree was cut from a commit that is no longer the tip, and
  // merging anyway is how one task's work silently reverts another's.
  const actual = await resolveSha(repo, "HEAD");
  if (actual !== expectedBaseSha) {
    return {
      status: "base_moved",
      branch,
      expected: expectedBaseSha,
      actual,
      message:
        `${into} moved from ${expectedBaseSha.slice(0, 8)} to ${actual.slice(0, 8)} since ` +
        `'${branch}' was cut. Rebase the task's worktree onto ${actual.slice(0, 8)} and verify ` +
        `again before merging — merging now would revert whatever landed in between.`,
    };
  }

  // An empty merge is a failure, not a success (defect 31). `git merge` answers
  // "Already up to date" and exits 0 for a branch that never got a commit, so the log
  // would carry `merge_completed` with a result sha identical to the base while the
  // worker's work sat uncommitted in a worktree about to be removed. Counted here
  // rather than by comparing shas, because a branch may legitimately be behind for
  // other reasons and "no commits of its own" is the fact we mean.
  const ahead = await git(repo, ["rev-list", "--count", `${into}..${branch}`]);
  if (Number(ahead) === 0) {
    return {
      status: "empty",
      branch,
      message:
        `'${branch}' has no commits of its own, so there is nothing to merge into ` +
        `${into} — the work was never committed. Its worktree is left in place: check ` +
        `what the worker wrote before re-running the task.`,
    };
  }

  const merge = await tryGit(repo, ["merge", "--no-ff", "--no-edit", branch]);
  if (merge.ok) {
    return { status: "merged", branch, resultSha: await resolveSha(repo, "HEAD") };
  }

  const files = await conflictedFiles(repo);
  // Leave the repo clean. A half-merged checkout is the state that makes the *next*
  // task fail for a reason that has nothing to do with it.
  await tryGit(repo, ["merge", "--abort"]);

  return {
    status: "conflicted",
    branch,
    files,
    message:
      files.length > 0
        ? `'${branch}' conflicts with ${into} in ${files.join(", ")}. The merge was aborted and ` +
          `${into} is untouched. Resolve on the task branch, re-verify, then re-queue.`
        : `'${branch}' could not be merged into ${into}: ${merge.stderr}. The merge was aborted.`,
  };
}

/**
 * One mutex, held as a promise chain. Every merge waits for the previous one to
 * finish, including its checkout and its abort, so no two merges ever see the repo
 * mid-operation.
 */
export function createMergeQueue(repo: string): MergeQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    merge(request) {
      pending++;
      const next = tail.then(
        () => performMerge(repo, request),
        () => performMerge(repo, request),
      );
      // The chain must survive a rejection, or one failed merge deadlocks every
      // merge after it.
      tail = next.catch(() => undefined);
      return next.finally(() => {
        pending--;
      });
    },
    get pending() {
      return pending;
    },
  };
}
