// The two places a mission blocks on a person (§2b), behind one interface.
//
// Blocking is allowed exactly twice, and both happen before any work is paid for:
// intake asks what the brief left genuinely ambiguous, and sign-off presents the
// outcome spec with what it expects to cost. Everything after is asynchronous.
//
// They are one port rather than two because they have the same shape from the loop's
// side — hand a human something, wait, get an answer — and because the thing on the
// other end changes. Phase 2 auto-approved and recorded that it did. The terminal
// reads stdin. The web shell resolves when someone clicks. If the loop knew which of
// those it was talking to, adding the shell would mean editing `prepareMission`, and
// the sequence that decides whether a mission is worth running would have three
// copies to keep in step.
//
// `unattendedHuman` is not a stub for a missing implementation. `--unattended` is a
// supported mode forever (§13), so "nobody is there" stays a real answer here.
import { type Budget } from "../domain/budget.js";
import { type Envelope } from "../domain/envelope.js";
import { type Criterion, type CriterionDiff, type Guess, type PlannedTask } from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type PermissionAsk } from "../workers/acp/permissionPort.js";
import { type IntakeQuestion } from "./calls.js";

export interface IntakeAnswer {
  questionId: string;
  answer: string;
}

/**
 * Everything the sign-off screen renders (§13), assembled by the caller.
 *
 * Passed as a value rather than as folded state, so the terminal and the shell cannot
 * disagree about what a human was shown before approving. `guesses` is here and
 * listed early on the screen for the reason §13 gives: a plausible-looking plan goes
 * wrong quietly, and the guesses are where it does it.
 */
export interface SignoffPresentation {
  missionId: string;
  goal: string;
  brief: string;
  criteria: readonly Criterion[];
  guesses: readonly Guess[];
  outOfScope: readonly string[];
  envelope: Envelope;
  plan: readonly PlannedTask[];
  estimate: Estimate;
  /** Present only on the mid-mission return (§3): what the replan wants to change
   *  about a criterion, and why. Absent on the initial sign-off. */
  proposedChange?: { diff: readonly CriterionDiff[]; reasoning: string };
}

/** `revise` is feedback, not a rejection — it replans and comes back (§13). */
export type SignoffDecision = { kind: "approve" } | { kind: "revise"; feedback: string };

export interface HumanPort {
  /**
   * Asks what it is given and returns what came back. The cap is applied before this
   * is called (`loop/intake.ts`), because a port that trims its own input is a second
   * place the limit lives.
   *
   * An answer may be omitted; an unanswered question becomes a labelled guess rather
   * than a reason to keep asking.
   */
  askIntake(questions: readonly IntakeQuestion[]): Promise<IntakeAnswer[]>;
  awaitSignoff(presentation: SignoffPresentation): Promise<SignoffDecision>;
  /**
   * Running out of budget is a question, not a failure (§9.4): forty minutes into a
   * four-hour mission with one criterion outstanding, the useful move is twenty more
   * minutes rather than abandoning three hours of paid work.
   *
   * Optional, and absent means declined — the mission is abandoned with its artifacts
   * intact rather than quietly continuing. Capped at two extensions in the loop, and
   * never granted under `--unattended`: a flag that skips reading the plan is a
   * reasonable trade, one that lets an unwatched mission raise its own spending limit
   * is not.
   */
  requestExtension?(request: ExtendRequest): Promise<Budget | undefined>;
  /**
   * The third place a human is needed, and the only one that happens *mid-run*: a
   * live ACP agent asking for a capability outside its grant (§12, `workers/acp`).
   *
   * It is on this port rather than on one of its own because it is the same human
   * and the same race — whichever surface answers first wins (§10's one inbox). Two
   * differences from the pair above, both deliberate: a worker is awaiting the
   * answer, so a surface that cannot answer must **reject** rather than deny on the
   * human's behalf; and the absence of the method means nobody is there, which the
   * permission port reads as a denial rather than a wait.
   */
  askPermission?(request: PermissionAsk): Promise<boolean>;
}

/** What the human is shown when the money runs out. Mirrors §9.4's list: what is met,
 *  what is not, what was spent, and how many extensions have already been granted. */
export interface ExtendRequest {
  missionId: string;
  spentWallMs: number;
  budget: Budget;
  unmetCriteria: string[];
  extensionsUsed: number;
}

/** Nobody is there: ask nothing, approve the plan. What `--unattended` means, and the
 *  behaviour every test written before this port existed already assumed. */
export const unattendedHuman = (): HumanPort => ({
  askIntake: async () => [],
  awaitSignoff: async () => ({ kind: "approve" }),
  // No `requestExtension`. §9.4 is explicit that an unattended mission parks rather
  // than raising its own ceiling, and the loop reads the method's absence as exactly
  // that — so the rule is expressed by what this object does not have.
});

/**
 * One human, reachable two ways: whichever surface answers first wins.
 *
 * §10's rule is one inbox rather than three surfaces, and this is the same rule one
 * level down. A mission started in a terminal that also serves a dashboard has two
 * places the same approval can come from. Making them pick one surface in advance
 * is not a problem this function should introduce.
 *
 * `Promise.any` rather than `Promise.race`, and the difference is the whole point: a
 * terminal with no tty rejects immediately, and a race would take that rejection as
 * the answer and abandon a browser that was about to be used. Rejecting only when
 * *every* surface has failed is what makes "run it in the background and approve from
 * the tab" work.
 */
export function anyOf(ports: readonly HumanPort[]): HumanPort {
  if (ports.length === 1) return ports[0]!;

  return {
    askIntake: (questions) => Promise.any(ports.map((port) => port.askIntake(questions))),
    awaitSignoff: (presentation) => Promise.any(ports.map((port) => port.awaitSignoff(presentation))),
    requestExtension: (request) => {
      const able = ports.filter((port) => port.requestExtension);
      if (able.length === 0) return Promise.resolve(undefined);
      return Promise.any(able.map((port) => port.requestExtension!(request)));
    },
    // Present only when a surface can actually answer, because the permission port
    // reads its absence as "nobody is there" and denies rather than waiting. A method
    // that existed here and rejected instantly would deny every mid-run request on a
    // machine with no tty, which is the opposite of what `Promise.any` is for.
    ...(ports.some((port) => port.askPermission)
      ? {
          askPermission: (request: PermissionAsk) =>
            Promise.any(
              ports.filter((port) => port.askPermission).map((port) => port.askPermission!(request)),
            ),
        }
      : {}),
  };
}
