// The five decision points (§3). Every model call the orchestrator makes is one of
// these; a model call that is not on this list does not exist.
//
// This interface is the seam the loop is written against, which is what lets the
// whole loop run in tests against scripted answers with no model and no spend.
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

export interface PlanInput {
  goal: string;
  ledger: TaskLedger;
  envelope: Envelope;
  /** Present on a replan; absent on the first plan. */
  reason?: string;
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
  plan(input: PlanInput): Promise<PlanResult>;
  synthesize(input: SynthesizeInput): Promise<AgentSpec>;
  progress(input: ProgressInput): Promise<ProgressLedger>;
  judge(input: JudgeInput): Promise<JudgeResult>;
}
