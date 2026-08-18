// Derived files a worker cannot help producing, kept out of git's sight (defect 43).
//
// **The system obliged an artifact and then failed the task for producing it.** Observed
// on a real mission on 2026-08-16: the goal was a Python script, the plan told the worker
// to verify with `python3 -m py_compile add.py`, a criterion ran the same command, and
// CPython wrote `__pycache__/add.cpython-314.pyc` beside the source. The repo had no
// ignore line for it, so `commitWorktree`'s `git add -A` committed it, `changedFiles`
// reported it, and `detectEscape` failed the task **without retry** — "the plan was wrong
// about what this work touches". The plan was right. The work was correct and complete.
//
// This is the artifact-directory collision (P2, defects 27 and 41) in its third shape: a
// worker obliged to produce something with nowhere legal to put it. There the answer was
// to give it a directory; here it is to stop counting a file that is not repository
// content in the first place.
//
// **`$GIT_COMMON_DIR/info/exclude`, not `.gitignore`.** The user's tracked ignore file is
// theirs, and a mission that edited it would be committing an opinion about their project
// to their history. `info/exclude` is per-clone, never committed, and — verified against
// real git rather than assumed, because linked worktrees resolve most paths to their own
// `$GIT_DIR` — it *does* apply inside every linked worktree. Both halves of the failure
// close with the one write: `git add -A` will not stage an excluded file, so nothing is
// committed, and `ls-files --others --exclude-standard` will not report one, so nothing is
// counted as an escape. It also covers `readWorkingTree`, which `detectRepoEscape` (defect
// 41) compares before and after a *non*-code worker — a research task that ran a script
// would have tripped that the same way.
//
// **The list is short because a wide one hides real escapes.** Every entry is derived
// output that no human authors and no task can legitimately be asked to produce; a task
// whose deliverable is a `.pyc` is not a task. Anything ambiguous — `dist/`, `build/`,
// `target/` — is deliberately absent: those are plausible names for real directories, and
// silently un-counting one would turn a genuine scope error into a file that vanishes when
// the worktree is deleted. That trade is the wrong way round: a false escape costs a
// replan, a missed one costs the evidence that the plan was wrong.
import fs from "node:fs";
import path from "node:path";
import { git } from "./repo.js";

const MARKER = "# orchestra: derived output a worker cannot avoid writing — never committed";
const END = "# orchestra: end";

/**
 * Caches and installed trees, never sources.
 *
 * Each is here because a verification step a plan would reasonably ask for produces it:
 * `py_compile` and any `import` write `__pycache__`; `pytest`, `mypy` and `ruff` each
 * leave their own cache; an `npm test` that has to install first leaves `node_modules`.
 * `.DS_Store` is not produced by a command at all — it is written by the Finder while
 * somebody watches a mission run, which makes it the one entry here that fails a task for
 * something the worker did not do.
 *
 * **A scanner criterion's leftovers are deliberately not here** (PLAN-NEXT 6.3). Running
 * `deepsec process` in direct mode auto-creates its project store as a bare `data/` at
 * the repository root — observed, not guessed — and `data/` is exactly the kind of
 * plausible source-directory name the paragraph above refuses to un-count. `.deepsec/` is
 * what its `init` flow creates, which this gate never runs, so excluding that would be a
 * guess about a path nothing here produces. The scan runs between rounds in the
 * operator's own checkout rather than inside a worktree, so what it leaves is untracked
 * clutter a person can see and delete, not a file a worker stages.
 */
export const DERIVED_PATHS: readonly string[] = [
  "__pycache__/",
  "*.py[cod]",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "node_modules/",
  ".DS_Store",
];

export interface ExcludeResult {
  file: string;
  /** False when the block was already exactly right — the common case on every run
   *  after the first, and worth distinguishing so a caller can stay quiet about it. */
  written: boolean;
}

/**
 * Writes the block into this repository's `info/exclude`, idempotently.
 *
 * Re-asserted on every worktree creation rather than once at init, for the reason
 * `ensureGitignored` is (§17): the failure being prevented is somebody deleting the lines,
 * or a repo that never had them. The block is delimited and rewritten whole, so editing
 * `DERIVED_PATHS` updates an existing checkout instead of appending a second copy — and
 * anything a human put in the file outside the markers is preserved untouched.
 *
 * Best-effort by design. A repository whose git directory cannot be located or whose
 * `info/` cannot be written is not a reason to fail a dispatch: the consequence is the
 * behaviour that existed before this file, which is a task that may fail on a byte-cache
 * — bad, and still not worth refusing to do the work over.
 */
export async function ensureDerivedExcluded(repo: string): Promise<ExcludeResult> {
  const gitDir = await commonGitDir(repo);
  const file = path.join(gitDir, "info", "exclude");
  const block = [MARKER, ...DERIVED_PATHS, END].join("\n");

  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = replaceBlock(existing, block);
    if (next === existing) return { file, written: false };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    return { file, written: true };
  } catch {
    // See the header: the fallback is the old behaviour, not a failed mission.
    return { file, written: false };
  }
}

/**
 * Swaps the delimited block for a new one, or appends it when there is none.
 *
 * Pure and exported so the editing rule is assertable without a repository — the two ways
 * it can be wrong are both silent. Appending instead of replacing grows the file by a
 * block per run; replacing too greedily eats whatever a human wrote around it.
 */
export function replaceBlock(existing: string, block: string): string {
  const start = existing.indexOf(MARKER);
  if (start === -1) {
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}${block}\n`;
  }

  const endAt = existing.indexOf(END, start);
  // A truncated block — the marker present and its terminator gone — is treated as
  // running to the end of the file rather than left in place, because the alternative is
  // appending a second block after a broken first one on every run from here on.
  const after = endAt === -1 ? "" : existing.slice(endAt + END.length).replace(/^\n/, "");
  return `${existing.slice(0, start)}${block}\n${after}`;
}

/** The *common* git directory, which is what linked worktrees share — `.git` is a file
 *  rather than a directory inside one, so joining `.git/info/exclude` onto a path is
 *  wrong for exactly the checkouts this is about. */
async function commonGitDir(repo: string): Promise<string> {
  const found = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  return path.isAbsolute(found) ? found : path.join(repo, found);
}
