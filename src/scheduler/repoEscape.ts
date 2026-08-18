// The escape check for a worker that has no lease to escape (defect 41).
//
// §4 makes git a property of `code` tasks, correctly: a `research` or `review` worker
// gets no worktree, no lease, no auto-commit, and no post-hoc diff. What run 8 showed
// is that the same worker still runs *in the repository checkout*, so a goal like "fix
// any problems you find directly" produces real edits that nobody commits — and then
// criterion checks, which run with `cwd` = the repo (§4), grade a working tree
// containing them. The mission reported `complete` partly on work nobody versioned.
//
// The fix is refusal rather than a second commit path. Committing whatever a non-code
// worker leaves behind would build a code path with no lease, no worktree, no escape
// check and no merge gate — every guarantee §8 and defects 30/31 bought, reachable by
// staffing a task `review`. The mis-staffing is the bug, so the check names it.
//
// Comparison rather than "is it dirty", because a human's own uncommitted work in the
// checkout is none of the mission's business and failing a task over it would make the
// orchestrator unusable in a working repo.
import { type WorkingTree } from "../git/repo.js";

export type RepoEscape = { escaped: true; touched: string[]; message: string } | { escaped: false };

export function detectRepoEscape(before: WorkingTree, after: WorkingTree): RepoEscape {
  const seen = new Set(before.lines);
  const appeared = after.lines.filter((line) => !seen.has(line));

  // A status line that stayed identical while the patch moved is a further edit to a
  // file that was already dirty. There is no per-file attribution to be had without
  // parsing the patch — a scanner over structured text is how defects 34, 37 and 38
  // happened — so it reports the paths git already named rather than guessing which.
  const touched =
    appeared.length > 0
      ? appeared.map(pathOf)
      : before.patch === after.patch
        ? []
        : after.lines.map(pathOf);

  if (touched.length === 0) return { escaped: false };

  return {
    escaped: true,
    touched,
    message:
      `Worker changed the repository checkout: ${touched.join(", ")}. This task has no ` +
      `worktree and no lease, so the changes are uncommitted, unverified, and would be ` +
      `graded as if they had landed. Work that edits tracked files is a \`code\` task ` +
      `(§4) — replan it as one, or narrow this task's goal to something that writes no ` +
      `files. The checkout is left as the worker made it; nothing was reverted.`,
  };
}

/** `XY path` in porcelain v1, and a rename carries ` -> `. Only ever shown to a human. */
function pathOf(line: string): string {
  const path = line.slice(3);
  const arrow = path.lastIndexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}
