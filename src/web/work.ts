// What a finished mission actually produced, named — and named in a way a browser
// cannot spell (PLAN-NEXT 9.3).
//
// The complaint this closes is exact: a finished mission reported that it finished.
// The diffs, the evidence files and the design note were all on disk the whole time
// with their paths already folded, so the gap was a rendering one. What makes it a
// *security* problem rather than a layout one is the step in the middle: the page has
// to say which of them to open, and a filename crossing the socket is a browser
// naming a path to a process that reads files.
//
// So nothing here is a path the page ever holds. This module folds the log into a
// list of readable things, gives each one the `seq` of the event that recorded it as
// its id, and the page sends back an id. The server rebuilds the same list from its
// *own* copy of the log and looks the id up — which is `workspace_add`'s rule (you
// cannot open a file you have not been shown) applied to a file, and it is why the
// same reducer runs on both sides: two implementations of "which files exist" is one
// implementation of "which files the server will open" and one of "which files the
// page will ask for", and only the first one is a rule.
//
// Pure, and free of node builtins on purpose — `web/app/state.ts` imports it into the
// browser bundle, exactly as it imports the `Event` union as a type.
import { type Event } from "../events/schema.js";

/** One file a mission wrote, as the page knows it: a label and an id, never a path. */
export interface WorkFile {
  /** The `seq` of the event that recorded the file. Stable across replays, unique per
   *  log, and meaningless as a path — which is the whole point. */
  readonly id: string;
  readonly label: string;
  /** Absolute, and stripped before this ever reaches a socket (`server.ts` sends the
   *  rendered text, never the frame this field is in). */
  readonly path: string;
}

/** What one task's work landed as: the two shas `git diff` needs. `to` is absent while
 *  a merge is in flight, and forever on a merge that conflicted or was empty — both of
 *  which are a task with nothing to show, said honestly rather than as an empty diff. */
export interface MergeRange {
  readonly taskId: string;
  readonly branch: string;
  readonly from: string;
  readonly to?: string;
}

export interface WorkView {
  readonly files: readonly WorkFile[];
  readonly merges: readonly MergeRange[];
}

export const emptyWork = (): WorkView => ({ files: [], merges: [] });

/** What the page asks to see. Two kinds and one id, checked against the log. */
export interface ShowRequest {
  readonly what: "diff" | "file";
  readonly id: string;
}

/**
 * What comes back: rendered text and the title it was rendered under.
 *
 * Here rather than beside the reader that produces it, because `wire.ts` names this
 * type and `showWork.ts` imports `node:fs` — a type-only import is erased, but a
 * browser module that mentions a server module at all is one careless `import` away
 * from bundling it.
 */
export interface Shown {
  readonly what: "diff" | "file";
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** A file, replacing any earlier entry for the same path: a criterion re-checked in a
 *  later round overwrites its evidence file, so two rows for one path would offer the
 *  same bytes twice under two ids and let the older label describe the newer content. */
const withFile = (files: readonly WorkFile[], file: WorkFile): WorkFile[] =>
  files.filter((each) => each.path !== file.path).concat([file]);

/**
 * One event onto the work listing.
 *
 * A reducer rather than a scan over the array because the page folds event by event
 * and the server folds a whole log, and those had to be the same function — see the
 * header. Returns the same object when nothing applies, so `apply` can tell whether
 * the view actually changed.
 */
export function foldWork(work: WorkView, event: Event): WorkView {
  switch (event.type) {
    // The architect's design note (PLAN-NEXT 5.4): the event names a file rather than
    // carrying one, which is exactly the shape this module exists to render.
    case "design_written":
      return {
        ...work,
        files: withFile(work.files, {
          id: String(event.seq),
          label: "design note",
          path: event.path,
        }),
      };

    // A panel seat is a record and not a verdict (PLAN-NEXT 6.1), and the guard is here
    // for the same reason it is in `fold` and in `state.ts` `apply`: the seats stream in
    // before the resolved verdict, and listing them would put three rows named after one
    // criterion above the one file that says how the panel actually voted.
    case "criterion_checked": {
      if (event.panelSeat !== undefined) return work;
      const path = event.evidence.checkOutputPath;
      if (!path) return work;
      return {
        ...work,
        files: withFile(work.files, {
          id: String(event.seq),
          label: `criterion ${event.criterionId}`,
          path,
        }),
      };
    }

    // `report` and `diff` artifacts carry their content in the event itself, so there is
    // nothing to open; the other three are references to a path (§9.1 keeps screenshots
    // out of the log for exactly that reason) and are the ones worth a row.
    case "artifact_written": {
      const artifact = event.artifact;
      if (artifact.kind === "report" || artifact.kind === "diff") return work;
      return {
        ...work,
        files: withFile(work.files, {
          id: String(event.seq),
          label: `${artifact.kind} ${artifact.id}`,
          path: artifact.path,
        }),
      };
    }

    // A retried merge starts again on the same task, so the range is replaced rather
    // than appended: an earlier attempt's `intoSha` is a base the branch no longer sits
    // on, and a diff from it would show another task's merged work as this one's.
    case "merge_started": {
      if (!event.taskId) return work;
      const range = { taskId: event.taskId, branch: event.branch, from: event.intoSha };
      return { ...work, merges: work.merges.filter((each) => each.taskId !== event.taskId).concat([range]) };
    }

    case "merge_completed":
      return {
        ...work,
        merges: work.merges.map((each) =>
          each.taskId === event.taskId && each.to === undefined
            ? { ...each, to: event.resultSha }
            : each,
        ),
      };

    default:
      return work;
  }
}

export const workOf = (events: readonly Event[]): WorkView => events.reduce(foldWork, emptyWork());

/**
 * Whether a string is a git object name and nothing else.
 *
 * The shas come off this process's own log, so this is not defending against a browser
 * — it is defending against a *hand-edited* log, which `registry.ts` already treats as
 * a thing that happens. `git diff -foo..bar` reads the leading `-` as an option, and
 * the argument vector is where that would land: `run` spawns without a shell, so there
 * is no quoting to get wrong, and an option is the one thing a bare argument can still
 * become.
 */
export const isSha = (text: string): boolean => /^[0-9a-f]{7,64}$/.test(text);

/** How much of a file or a diff crosses the socket. A merge of a vendored directory is
 *  megabytes of patch, and a tab that has to parse it before painting anything is a
 *  dashboard that hangs on exactly the missions worth looking at. */
export const SHOWN_LIMIT = 200_000;

/** Truncated at a line boundary, and saying so: a patch cut mid-hunk reads as a patch
 *  that ends there, and "the last file changed nothing" is the wrong conclusion to hand
 *  somebody reviewing merged work. */
export function clip(text: string, limit = SHOWN_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  return { text: lastBreak > 0 ? cut.slice(0, lastBreak) : cut, truncated: true };
}
