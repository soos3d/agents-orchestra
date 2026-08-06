// The five decision points (§3). Every model call the orchestrator makes is one of
// these; a model call that is not on this list does not exist.
//
// This interface is the seam the loop is written against, which is what lets the
// whole loop run in tests against scripted answers with no model and no spend.
import { type AgentSpec, type WorkerKind } from "../domain/task.js";
import { type Envelope } from "../domain/envelope.js";
import { type Evidence, type VerifySpec } from "../domain/artifacts.js";
import {
  type Criterion,
  type Finding,
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
}

export interface PlanInput {
  goal: string;
  ledger: TaskLedger;
  envelope: Envelope;
  /** Present on a replan; absent on the first plan. */
  reason?: string;
}

export interface SynthesizeInput {
  task: PlannedTask;
  envelope: Envelope;
  toolCatalogue: string[];
}

export interface ProgressInput {
  criteria: Criterion[];
  /** This round's reports — the entire evidence base, since there is no transcript. */
  reports: { taskId: string; report: WorkerReport }[];
  /** The last few progress ledgers, which is how `isInLoop` is answerable at all. */
  recentProgress: ProgressLedger[];
  counters: { round: number; stalls: number; resets: number };
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
  plan(input: PlanInput): Promise<PlannedTask[]>;
  synthesize(input: SynthesizeInput): Promise<AgentSpec>;
  progress(input: ProgressInput): Promise<ProgressLedger>;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

/** Concurrency is per worker kind, not one global number: six parallel research
 *  calls and six parallel browser sessions are not the same risk. */
export const CONCURRENCY: Record<WorkerKind, number> = {
  code: 4,
  research: 4,
  review: 4,
  general: 4,
  // One real logged-in browser session. Parallel tabs in the same account is how
  // two tasks submit the same form (§11).
  computer: 1,
};
