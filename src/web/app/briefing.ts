// What a mission is doing before it asks (UI plan U5).
//
// The screens between "start mission" and sign-off used to appear minutes apart with
// nothing in between: a person typed a goal and then watched a blank page for long
// enough to wonder whether the process had died. Everything they wanted to see was
// already on the log — a scan finished, questions were asked and answered, a brief was
// written — and none of it was drawn.
//
// This is that sequence, as a pure function of the folded view. No new event, no new
// call, nothing that reaches `prepareMission`. Pure and separately tested because the
// alternative is a component full of ternaries that nothing can assert, and because
// three of its rules are load-bearing rather than cosmetic:
//
//  - **A stage that never happens is not drawn as skipped.** §2b caps intake at three
//    questions asked *once*, and a mission with no ambiguity is asked nothing at all.
//    A row reading "0 questions" reports a step that was never owed.
//  - **Exactly one stage is `running`.** The running row is the only thing on this
//    screen that moves — the stylesheet's rule, the same one the board follows — so
//    two of them would make motion mean nothing. Two stages share the `specifying`
//    status (the spec is written, then the work is planned), which is precisely why
//    "running" is the first unfinished stage rather than a match on the status.
//  - **`done` is evidence, never elapsed time.** A reconnecting tab replays from seq 0
//    and rebuilds the identical trail, because every verdict here reads the fold.
import { type View } from "./state.js";

export type StageState = "done" | "running" | "waiting";

export interface Stage {
  key: string;
  label: string;
  state: StageState;
  /** One line of what actually came back. Empty until the stage is done. */
  detail: string;
}

/** The prepare statuses, in the order `prepareMission` moves through them. Anything
 *  past sign-off belongs to the loop, and the briefing is over. */
const ORDER = ["scanning", "intake", "researching", "specifying", "awaiting_signoff"] as const;

/**
 * Whether the briefing is what this mission is currently about. A mission that has
 * started executing has a board, and the board is a better answer than a trail.
 *
 * It takes the view rather than the status because of the case that is neither: a
 * status this page has not heard yet. Empty means "no `mission_status` has arrived",
 * which is a mission a second old — *unless* there is already a board or an inbox, in
 * which case something is on screen that a person may be waiting to answer, and a
 * trail drawn over a pending permission is a worker left hanging (§12).
 */
export const isPreparing = (view: View): boolean =>
  (ORDER as readonly string[]).includes(view.status) ||
  (view.status === "" && view.tasks.size === 0 && view.inbox.size === 0);

/** How far the mission has got. An empty status is a mission created a moment ago:
 *  the scan is what happens next, so it ranks at the first stage rather than before
 *  it — otherwise a fresh mission shows a trail with nothing in flight. */
const rank = (status: string): number => {
  const index = (ORDER as readonly string[]).indexOf(status);
  return index === -1 ? (status === "" ? 0 : ORDER.length) : index;
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface Step {
  key: string;
  label: string;
  /** Which status this step runs under. */
  at: number;
  done: boolean;
  detail: string;
  /** What to say while it is in flight. Only sign-off has one: every other stage's
   *  line is a report of what came back, and there is nothing to report yet. */
  whileRunning?: string;
}

export function briefing(view: View): Stage[] {
  const at = rank(view.status);

  // The criteria the *ledger* holds, not the ones the view draws. `prepareMission`
  // decides the criteria, revises the ledger with them, and only then plans — but
  // `outcome_spec_written` carries the estimate, so it cannot be emitted until the
  // plan exists. Keying the spec stage on `view.criteria` therefore marks it done at
  // the same instant as the plan, and the trail shows the work happening in an order
  // it did not happen in. The ledger's `reason: "spec"` revision is the real evidence.
  const specWritten = (view.ledger?.criteria.length ?? 0) > 0 || view.criteria.length > 0;

  const steps: Step[] = [
    {
      key: "scan",
      label: "scan the ground",
      at: 0,
      done: view.scanned,
      detail: view.findings > 0 ? count(view.findings, "finding", "findings") : "nothing already known",
    },
    ...(view.intakeAsked > 0 || view.status === "intake"
      ? [
          {
            key: "intake",
            label: "ask what is ambiguous",
            at: 1,
            done: view.intakeAsked > 0 && view.intakeAnswered >= view.intakeAsked,
            detail: `${count(view.intakeAsked, "question", "questions")} · ${view.intakeAnswered} answered`,
          },
        ]
      : []),
    { key: "research", label: "research", at: 2, done: view.brief !== "", detail: "brief written" },
    {
      key: "spec",
      label: "write the outcome spec",
      at: 3,
      done: specWritten,
      detail: `${count(view.criteria.length || (view.ledger?.criteria.length ?? 0), "criterion", "criteria")} · ${count(view.guesses.length, "guess", "guesses")}`,
    },
    {
      key: "plan",
      label: "plan the work",
      at: 3,
      done: view.plan.length > 0,
      detail: view.estimate
        ? `${count(view.plan.length, "task", "tasks")} · ~${Math.round(view.estimate.wallMs / 60000)} min`
        : count(view.plan.length, "task", "tasks"),
    },
    {
      key: "signoff",
      label: "your call",
      at: 4,
      done: at > 4,
      detail: "approved",
      whileRunning: "nothing runs until you approve",
    },
  ];

  // The running stage is the first unfinished one the mission has actually reached.
  // Written this way rather than as `step.at === at` because two steps share the
  // `specifying` status, and because a step whose evidence never arrived must not go
  // on pulsing after the mission has moved past it.
  const running = steps.find((step) => !step.done && step.at <= at)?.key;

  return steps.map((step) => ({
    key: step.key,
    label: step.label,
    state: step.done ? "done" : step.key === running ? "running" : "waiting",
    detail: step.done ? step.detail : step.key === running ? (step.whileRunning ?? "") : "",
  }));
}
