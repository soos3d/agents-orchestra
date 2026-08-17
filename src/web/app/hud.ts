// What the instrument panel says, as a pure function of the folded view (UI plan U7).
//
// The HUD is read at hour four of a run, from across a desk, out of the corner of an
// eye. That is a different job from the briefing's, and it has one governing rule:
// **movement and colour mean something happened**. A panel that glows all the time is
// a panel nobody looks at, so the decisions about what glows, what spins and what is
// drawn at all live here rather than as ternaries inside a component — the same reason
// `briefing.ts` is a module and not a pile of JSX conditions.
//
// Three rules are load-bearing rather than cosmetic:
//
//  - **A human being waited on outranks everything.** A mission with a pending question
//    is *stopped*, whatever else is running, and the core says so. Every other state is
//    something the machine can carry on from alone.
//  - **A zero counter is not drawn.** "stalls 0" is a row that never changes, and a
//    panel of rows that never change teaches the eye to skip the panel — which is how
//    the one row that *did* change gets missed.
//  - **Elapsed time is never negative.** It is the log's timestamp minus this machine's
//    clock, and those two disagree: a resumed mission written on a laptop that has since
//    slept can produce a start in the future, and a HUD reading "-3s" reads as a bug in
//    the orchestrator rather than in the clock.
import { type View } from "./state.js";

/** The semantic colours, and the accent kept separate from them. `live` is cyan and
 *  means *running*; nothing else may claim it (the stylesheet's rule, stated as a
 *  type). `idle` paints nothing. */
export type Tone = "live" | "met" | "attn" | "fail" | "idle";

export interface Core {
  /** Two words at most: this is read, not studied. */
  label: string;
  tone: Tone;
  /** Whether the ring turns. Exactly one thing on the page rotates, and it rotates
   *  only while work is actually in flight. */
  spin: boolean;
  /** Why, in a short phrase. Empty when the label already said it. */
  detail: string;
}

/** Statuses the loop cannot carry on from by itself. */
const FAILED = ["failed", "abandoned"];

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The cards a person is being waited on by. Intake has a screen of its own, so it is
 *  not an inbox item the core counts — the whole page is already that question. */
const waiting = (view: View): number =>
  [...view.inbox.values()].filter((item) => item.kind !== "intake").length;

const running = (view: View): number =>
  [...view.tasks.values()].filter((task) => task.status === "running").length;

/** How many things this mission has produced that can actually be opened: a file it
 *  wrote, or a merge that completed. A started-and-never-finished merge is counted out
 *  deliberately — it has no second sha, so there is nothing to diff, and a row that
 *  refuses every click is worse than no row (PLAN-NEXT 9.3). */
export const openable = (view: View): number =>
  view.work.files.length + view.work.merges.filter((merge) => merge.to !== undefined).length;

/**
 * The status core: the one element on the page that rotates, and the first thing a
 * returning human looks at.
 *
 * The order of these branches is the whole design. A pending question comes before a
 * failure and before anything running, because it is the only state where the person
 * reading has something to do — a failed mission has already stopped and will still be
 * stopped in a minute, and a running one needs nothing. Paused comes next for the same
 * reason inverted: it is stopped *by* a human and only a human lifts it.
 */
export function core(view: View): Core {
  const held = waiting(view);
  if (held > 0) {
    return { label: "needs you", tone: "attn", spin: false, detail: plural(held, "question") };
  }
  if (view.paused) {
    return { label: "paused", tone: "attn", spin: false, detail: "nothing is dispatched" };
  }
  if (FAILED.includes(view.status)) {
    return { label: view.status, tone: "fail", spin: false, detail: "the loop stopped here" };
  }
  if (view.status === "complete") {
    const met = view.criteria.filter((criterion) => criterion.met === true).length;
    return {
      label: "complete",
      tone: "met",
      spin: false,
      detail: view.criteria.length > 0 ? `${met}/${view.criteria.length} criteria met` : "",
    };
  }
  const live = running(view);
  if (live > 0) {
    return { label: "running", tone: "live", spin: true, detail: plural(live, "task") };
  }
  if (view.status === "") return { label: "connecting", tone: "idle", spin: false, detail: "" };
  // Between rounds, verifying, replanning: the loop is working and no worker is out.
  // It spins because the process is doing something; it is not cyan because nothing
  // is dispatched, and cyan is reserved for a worker actually being out there.
  return { label: view.status, tone: "idle", spin: true, detail: "" };
}

/**
 * A duration a person can read at a glance, from milliseconds.
 *
 * Deliberately coarse above an hour: a run four hours in does not need its seconds,
 * and a field whose last two digits change every second is a field the eye is drawn
 * to for no reason.
 */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export interface Vital {
  label: string;
  value: string;
  tone?: Tone;
}

/**
 * The counters, minus the ones that are still zero.
 *
 * `now` is a parameter rather than a `Date.now()` call for the usual reason: a function
 * that reads the clock cannot be asserted, and the elapsed field is the one thing here
 * that changes without an event.
 */
export function vitals(view: View, now: number): readonly Vital[] {
  const all: readonly (Vital | null)[] = [
    view.startedAt ? { label: "elapsed", value: elapsed(now - Date.parse(view.startedAt)) } : null,
    view.round > 0 ? { label: "round", value: String(view.round) } : null,
    view.tasks.size > 0
      ? {
          label: "tasks",
          value: `${[...view.tasks.values()].filter((task) => task.status === "done").length}/${view.tasks.size}`,
        }
      : null,
    ...(view.criteria.length > 0 ? [criteriaVital(view)] : []),
    // Both of these are §9 counters that mean the loop is struggling, and both are
    // absent on a run that is going well. Drawn only when they are not zero, which is
    // exactly when a person needs to see them.
    view.stalls > 0 ? { label: "stalls", value: String(view.stalls), tone: "attn" as const } : null,
    view.resets > 0 ? { label: "resets", value: String(view.resets), tone: "attn" as const } : null,
  ];

  return all.filter((vital): vital is Vital => vital !== null);
}

function criteriaVital(view: View): Vital {
  const met = view.criteria.filter((criterion) => criterion.met === true).length;
  const failed = view.criteria.some((criterion) => criterion.met === false);
  return {
    label: "criteria",
    value: `${met}/${view.criteria.length}`,
    // A criterion checked false is not a failure — it is re-checked when a contributor
    // lands (P1, `loop/criteria.ts`) — so it is amber here and never red.
    tone: met === view.criteria.length ? "met" : failed ? "attn" : undefined,
  };
}

/** The centre rail's contents. Everything that is not the board is one click away, and
 *  this is that click as data. */
export type PaneKey = "board" | "map" | "task" | "contract" | "work" | "timeline";

export interface Pane {
  key: PaneKey;
  label: string;
  /** A count, or empty. Never a dot: a badge that says only "something" makes a person
   *  open the pane to find out, which is the click this rail exists to avoid. */
  badge: string;
}

export function panes(view: View): readonly Pane[] {
  const live = running(view);
  const shown = openable(view);
  return [
    {
      key: "board",
      label: "board",
      badge: view.tasks.size > 0 ? `${live}/${view.tasks.size}` : "",
    },
    // The same tasks as a figure rather than as five columns: what the board cannot
    // do is be glanced at. It carries no badge of its own — it would be the board's,
    // twice, and a rail of counters that agree teaches the eye to skip all of them.
    { key: "map", label: "map", badge: "" },
    // Only once there is one. A tab that is empty whenever nothing is selected is a
    // tab that teaches the eye it is usually empty; the board is how a task gets
    // picked, and this appears when one has been.
    ...(view.selected && view.tasks.has(view.selected)
      ? [{ key: "task" as const, label: "task", badge: view.selected }]
      : []),
    {
      key: "contract",
      label: "contract",
      badge: view.criteria.length > 0 ? String(view.criteria.length) : "",
    },
    // What the mission actually produced (PLAN-NEXT 9.3). Offered only once there is
    // something in it, for the `task` pane's reason: a tab that is empty for the first
    // half of every mission is a tab the eye learns to skip. The badge counts openable
    // things rather than tasks — a mission with five tasks and one merged diff has one
    // thing to read, and a badge of 5 would send somebody looking for the other four.
    ...(shown > 0 ? [{ key: "work" as const, label: "work", badge: String(shown) }] : []),
    { key: "timeline", label: "timeline", badge: "" },
  ];
}
