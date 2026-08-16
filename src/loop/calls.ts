// The decision points (§3). Every model call the orchestrator makes is one of these;
// a model call that is not on this list does not exist.
//
// This interface is the seam the loop is written against, which is what lets the
// whole loop run in tests against scripted answers with no model and no spend.
//
// §3 names five and `intake` is the sixth, which needs saying because the rule above
// is worth keeping honest. §3 carved intake out as "a real conversation" running in
// streaming-input mode, on the reading that it asks follow-ups off an answer. §2b
// caps it at three questions asked once, and once is not a conversation. So it lands
// here as an ordinary one-shot call instead — which keeps it above this seam, where
// the cap and the answers are assertable with no model. A streaming intake session
// would sit below it, in the one file six defects hid in.
import { type AgentSpec } from "../domain/task.js";
import { type Envelope } from "../domain/envelope.js";
import { type Evidence, type VerifySpec } from "../domain/artifacts.js";
import {
  type Criterion,
  type Finding,
  type Guess,
  type PlannedTask,
  type ProgressLedger,
  type TaskLedger,
} from "../domain/ledger.js";
import { type WorkerReport } from "../domain/report.js";

export interface ResearchInput {
  question: string;
  sources: ("memory" | "codebase" | "web" | "prior-art" | "apps")[];
  depth: "scan" | "deep";
  /**
   * What semantic memory already established, so research is not paid for twice
   * (§5, §6).
   *
   * Memory-sourced facts only. A fact this mission's own scan produced is not
   * "already known" in the sense that matters here — telling the research call it
   * knows what it just found is how a mission talks itself out of doing the work. A
   * stale memory is not here either: it entered the ledger as a guess precisely
   * because it must be re-verified rather than trusted.
   */
  known?: string[];
  /**
   * A saved mission's criteria skeleton (§7): what this job was judged against last
   * time, as a starting point to converge on.
   *
   * Statements only, and that is the point of the type. A replay re-runs scan and
   * research every time because the environment moved since March even if the job did
   * not, so handing the research call `met` or a piece of evidence would be handing it
   * last month's answer to this month's question.
   */
  priorCriteria?: { statement: string }[];
  /**
   * True when this call is the *only* research the mission will get — the scan on a
   * mission a human composed as quick.
   *
   * Without it the scan is asked for criteria and reasonably declines: it has been
   * told it is a scan, and on an ordinary mission the deep call is what writes the
   * outcome spec. Observed on a real run (2026-08-15): the scan returned no criteria,
   * `writeOutcomeSpec` refused `(empty)`, and the mission escalated to the deep call —
   * so quick cost two research calls instead of one and saved nothing. The field is
   * what makes the scan's own answer load-bearing on the run where it is.
   */
  solePass?: boolean;
  /**
   * Present only on the one retry, quoting what `writeOutcomeSpec` refused and why.
   *
   * `plan` has had `reason` and `synthesize` has had `rejected` since Phase 2, and
   * `research` re-ran on a byte-identical input — so the call whose answer decides
   * whether the mission can ever legitimately report success was the one asked to
   * guess again. The rejection is context the system already paid for; discarding it
   * and re-deriving it is how a retry becomes a coin flip.
   */
  rejected?: string;
}

export interface ResearchResult {
  brief: string;
  findings: Finding[];
  confidence: "high" | "medium" | "low";
  /**
   * The outcome spec (§5). Written by the research call rather than by a sixth
   * decision point, because §3 caps the list at five and the spec has to exist
   * before `plan` runs — criteria are an *input* to planning.
   *
   * Deliberately untyped: this is model output, and `writeOutcomeSpec` is the
   * boundary that rejects a criterion carrying no check. A `Criterion[]` here would
   * make the rejectable case unrepresentable and the validation untestable.
   */
  criteria?: readonly unknown[];
  guesses?: Guess[];
  outOfScope?: string[];
}

export interface IntakeInput {
  goal: string;
  /**
   * What the scan turned up, and the reason intake runs after it rather than before
   * (§2b). Asked blind, the three questions come back generic — "what does done look
   * like?", which the human already answered by writing the brief. Asked over
   * findings, they can name the two test commands the repo actually has.
   */
  findings: Finding[];
  /** Already-stated facts, so the same thing is not asked twice across a resume. */
  known: string[];
  envelope: Envelope;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  /** Offered where the answer is a choice; free text otherwise. */
  options?: string[];
}

export interface IntakeResult {
  questions: IntakeQuestion[];
}

export interface PlanInput {
  goal: string;
  ledger: TaskLedger;
  envelope: Envelope;
  /** Present on a replan; absent on the first plan. */
  reason?: string;
  /**
   * Present when a human ticked `quick` at compose time: a small job, to be planned as
   * one task rather than decomposed.
   *
   * Deliberately not enforced by a task-count cap in `validatePlan`. Task count is a
   * cost preference rather than a safety invariant, and a cap would fail a mission
   * outright over a mis-ticked box — while the human already sees `estimate.taskCount`
   * at sign-off, which is the cheaper place to catch it. Revisit if real runs show the
   * planner ignoring this.
   */
  scope?: "quick";
}

export interface PlanResult {
  tasks: PlannedTask[];
  /**
   * The criteria the planner believes the mission should be judged against.
   *
   * Returned rather than applied. After sign-off the loop diffs this against the
   * frozen set and turns any difference into a `criteria_change_requested` — so a
   * planner that cannot meet a criterion can *ask* to relax it and can never do it,
   * whatever it returns here (§3).
   */
  criteria?: Criterion[];
}

export interface SynthesizeInput {
  task: PlannedTask;
  envelope: Envelope;
  toolCatalogue: string[];
  /**
   * The transports that actually exist, which is a smaller set than §7's table
   * describes. Passed in for the same reason the envelope is: the registry is the
   * authority on what a synthesized agent may run on, and §7 says that decision "is
   * not left to the planner's judgment". Without it a model reads the table, picks
   * `agent-sdk`, and the task dies at dispatch instead of at validation.
   */
  transports: string[];
  /**
   * The agent CLIs a `cli` or `acp` spec may target, narrowed to what this machine can
   * start and to whatever harness the human pinned at compose time.
   *
   * The same argument as `transports`, one field along, and it was the half still
   * missing: `SYNTHESIZE_PROMPT` named "claude or codex" in prose, so a machine with
   * only `codex` installed still invited a spec targeting `claude` — defect 21 exactly,
   * discovered at dispatch rather than at validation.
   */
  targets: string[];
  /**
   * The model names a spec may name, or **empty for unconstrained**.
   *
   * `AgentSpec.model` is a required non-empty string that reaches `--model` on a real
   * CLI, and until this existed nothing checked it at all: an invented name passed
   * validation, was written into the log, and failed at dispatch with the task already
   * planned and staffed. Narrowed further by whatever the human pinned — see
   * `workers/harness.ts` `allowedModels`.
   *
   * Empty means nothing is *known*, never that nothing is allowed: no list of `codex`
   * models has been verified, and refusing every one of them to enforce the Anthropic
   * half would be the confident wrong answer (§9.5's rule, applied to a menu).
   */
  models: string[];
  /**
   * The roles this mission may staff from, already rendered to one line each by
   * `agents/offer.ts` — the documented roster plus anything a human has promoted
   * (§6, §7).
   *
   * A **rendered string** rather than a list of objects, and that is the whole
   * mechanism rather than a formatting choice. `describe()` JSON-dumps whatever it is
   * given straight into the prompt, so a list of role objects would carry every role's
   * body — some six hundred lines — into a call that needs to read eighteen
   * descriptions. Rendering at the seam makes the expensive half unreachable from
   * here by construction.
   *
   * What comes back is validated exactly as an unprompted spec is: the envelope, the
   * transport registry, and the lease rule all still apply, and naming a role grants
   * nothing. Absent when the roster is empty or switched off.
   */
  roster?: string;
  /** Present only on the one retry, quoting what was wrong with the last spec. */
  rejected?: string;
}

export interface ProgressInput {
  criteria: Criterion[];
  /** This round's reports — the entire evidence base, since there is no transcript. */
  reports: { taskId: string; report: WorkerReport }[];
  /** The last few progress ledgers, which is how `isInLoop` is answerable at all. */
  recentProgress: ProgressLedger[];
  counters: { round: number; stalls: number; resets: number };
  /**
   * Tasks that can never become ready because a dependency failed (§3). The
   * scheduler does not cancel them; naming them here is what turns "nothing happened
   * this round" into a blocking task the replan can act on.
   */
  frontier: { taskId: string; blockedBy: string[] }[];
  /**
   * What a human said since the last round, undelivered (§10).
   *
   * Present here and not only in the ledger because a note is meant to change the
   * *next decision*, and the progress call is where the next decision is made. It
   * also lands in `factsGiven`, which is what makes it survive a replan — the two
   * are not redundant: one steers this round, the other outlives it.
   */
  notes?: string[];
}

export interface JudgeInput {
  criterion: Criterion;
  check: Extract<VerifySpec, { kind: "judge" }>;
  /** Artifacts, not reports: a judge fed the worker's own summary is grading the
   *  thing it is grading. */
  artifactPaths: string[];
}

export interface JudgeResult {
  met: boolean;
  evidence: Evidence;
}

export interface Calls {
  research(input: ResearchInput): Promise<ResearchResult>;
  /** Returns questions; it never asks them. Who does the asking, and the cap on how
   *  many get through, are both above this seam (`loop/intake.ts`). */
  intake(input: IntakeInput): Promise<IntakeResult>;
  plan(input: PlanInput): Promise<PlanResult>;
  synthesize(input: SynthesizeInput): Promise<AgentSpec>;
  progress(input: ProgressInput): Promise<ProgressLedger>;
  judge(input: JudgeInput): Promise<JudgeResult>;
}
