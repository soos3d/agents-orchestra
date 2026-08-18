// The one place the dashboard reads something off the disk (PLAN-NEXT 9.3).
//
// Every path this file opens is derived from the mission's own log by `work.ts`. The
// request carries an **id** and never a path — the same rule that makes `compose` carry
// a `workspaceId`, one capability along, and for a sharper reason: a path from a browser
// reaching `readFileSync` in a process that also holds the operator's API keys is an
// arbitrary-read on a surface whose entire security model is "nobody can route to it".
// So the id is looked up in a listing this process just rebuilt from its own copy of the
// log, and a miss is a refusal rather than a fallback.
//
// It is here rather than in `server.ts` because `server.ts` sits below the fixture
// harness. This module touches disk and git and still has its own test with a real tmp
// dir and a real repo, which is what "every formatter is a pure function with a test"
// buys once the formatter has a filesystem under it.
import fs from "node:fs";
import { type Event } from "../events/schema.js";
import { tryGit } from "../git/repo.js";
import { clip, isSha, workOf, type ShowRequest, type Shown } from "./work.js";

export type { ShowRequest, Shown };

export interface ShowContext {
  readonly events: readonly Event[];
  /** The checkout the mission's merges landed in. Absent when the mission ran outside a
   *  repository, or — under `serve` — when its directory is not a workspace on this
   *  machine, which is the same refusal `resume` makes and for the same reason. */
  readonly repoRoot?: string;
}

export type ShowResult = { ok: true; shown: Shown } | { ok: false; problem: string };

/**
 * Reads one thing a mission produced.
 *
 * Async because a diff is a `git` subprocess. Every refusal names what to do instead,
 * per the project's error rule — a mission whose work cannot be shown is usually a
 * mission whose worktree was merged into a checkout this server was not started next
 * to, and "no diff" without that sentence sends somebody looking for a bug.
 */
export async function showWork(request: ShowRequest, context: ShowContext): Promise<ShowResult> {
  const work = workOf(context.events);

  if (request.what === "file") {
    const file = work.files.find((each) => each.id === request.id);
    if (!file) {
      return { ok: false, problem: "that file is not one this mission recorded writing." };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file.path, "utf8");
    } catch (error) {
      // Defect 30's shape: a path in a log cannot re-open a file somebody deleted, and
      // saying which path was tried is what turns that into a five-second diagnosis.
      return {
        ok: false,
        problem:
          `${file.label} is no longer at ${file.path} (${(error as Error).message}). ` +
          `The log records it; the file itself is gone.`,
      };
    }
    const { text, truncated } = clip(raw);
    return { ok: true, shown: { what: "file", id: file.id, title: file.label, text, truncated } };
  }

  const range = work.merges.find((each) => each.taskId === request.id);
  if (!range) {
    return { ok: false, problem: `task '${request.id}' never started a merge, so it landed no code.` };
  }
  if (!range.to) {
    return {
      ok: false,
      problem:
        `task '${request.id}' started a merge of ${range.branch} that never completed — ` +
        `it conflicted, was empty, or is still running. Nothing landed to diff.`,
    };
  }
  if (!context.repoRoot) {
    return {
      ok: false,
      problem:
        `this mission's checkout is not one this server can read. Add that directory as a ` +
        `workspace, or run 'git diff ${range.from}..${range.to}' in it.`,
    };
  }
  // A sha off a hand-edited log is the only way either of these is not a sha, and a
  // leading `-` in the argument vector is an option rather than a revision. `work.ts`
  // says the rest.
  if (!isSha(range.from) || !isSha(range.to)) {
    return { ok: false, problem: `the merge range recorded for '${request.id}' is not a pair of shas.` };
  }

  // `--stat` and the patch in one call: the file list is what a person reads first and
  // the patch is what they read next, and two subprocesses to put them on one screen is
  // a second failure mode for no second answer.
  const diff = await tryGit(context.repoRoot, ["diff", "--stat", "-p", `${range.from}..${range.to}`]);
  if (!diff.ok) {
    return {
      ok: false,
      problem:
        `git could not diff ${range.from}..${range.to} in ${context.repoRoot}: ${diff.stderr}. ` +
        `The merge is on the log, so the commits are probably in a different checkout.`,
    };
  }

  const { text, truncated } = clip(diff.stdout);
  return {
    ok: true,
    shown: {
      what: "diff",
      id: request.id,
      title: `${request.id} — ${range.branch}`,
      text: text || "The merge landed no changes to the tree.",
      truncated,
    },
  };
}
