// The fixture harness. Prompt building is a pure function of folded state, so a
// canned log plus scripted answers drives the whole loop with no model and no spend
// — which is the only way the milestone checklist is assertable at all.
import { type Budget, zeroSpend } from "../domain/budget.js";
import { type Envelope } from "../domain/envelope.js";
import {
  emptyLedger,
  type Criterion,
  type PlannedTask,
  type ProgressLedger,
} from "../domain/ledger.js";
import { type Mission } from "../domain/mission.js";
import { type WorkerReport } from "../domain/report.js";
import { type AgentSpec, type Task } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { type Calls, type JudgeResult, type ResearchResult } from "../loop/calls.js";
import { eventSchema, type Event, type EventInput } from "../events/schema.js";

export const anEnvelope = (patch: Partial<Envelope> = {}): Envelope => ({
  toolClasses: ["fs.read", "fs.write", "shell.run"],
  domains: [],
  fsRoots: ["/repo"],
  network: "none",
  maxSpend: { wallMs: 4 * 60 * 60_000 },
  approval: "local",
  ...patch,
});

export const aBudget = (patch: Partial<Budget> = {}): Budget => ({
  wallMs: 4 * 60 * 60_000,
  ...patch,
});

export const anAgentSpec = (patch: Partial<AgentSpec> = {}): AgentSpec => ({
  role: "health-endpoint-author",
  systemPrompt: "Add the endpoint described in the goal. Do not touch anything else.",
  worker: "code",
  transport: { id: "cli", target: "claude" },
  tools: ["fs.read", "fs.write"],
  model: "sonnet",
  verify: { kind: "command", command: "npm test" },
  ...patch,
});

export const aCriterion = (patch: Partial<Criterion> = {}): Criterion => ({
  id: "c1",
  statement: "GET /health returns 200 with {status:'ok'}",
  check: { kind: "command", command: "npm test" },
  ...patch,
});

export const aReport = (patch: Partial<WorkerReport> = {}): WorkerReport => ({
  outcome: "completed",
  summary: "Added the endpoint and a test.",
  criteriaTouched: ["c1"],
  claims: [],
  unknowns: [],
  deadEnds: [],
  artifacts: [],
  ...patch,
});

export const aProgressLedger = (patch: Partial<ProgressLedger> = {}): ProgressLedger => ({
  isRequestSatisfied: false,
  isInLoop: false,
  isProgressBeingMade: true,
  nextTasks: [],
  instruction: "keep going",
  unmetCriteria: ["c1"],
  ...patch,
});

export const aCodeTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    missionId: "m1",
    goal: "Add a /health endpoint",
    successCriteria: ["responds 200"],
    satisfies: ["c1"],
    motivatedBy: ["f7"],
    worker: "code",
    agentSpec: anAgentSpec(),
    dependsOn: [],
    status: "todo",
    artifacts: [],
    verify: { kind: "command", command: "npm test" },
    attempts: 0,
    budget: aBudget(),
    branch: "feat/health",
    owns: ["src/routes/health.ts"],
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
    ...patch,
  }) as Task;

export const aMission = (patch: Partial<Mission> = {}): Mission => ({
  id: "m1",
  goal: "Add a /health endpoint",
  ledger: emptyLedger(),
  capabilityEnvelope: anEnvelope(),
  status: "executing",
  round: 1,
  stalls: 0,
  resets: 0,
  budget: aBudget(),
  spend: zeroSpend(),
  spendByPhase: {},
  extensions: 0,
  unattended: false,
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
  ...patch,
});

/** Folded state built directly, for the pure functions that read it. The fold path
 *  itself is covered by `fold.test.ts`; building a log to reach one status here
 *  would test the folder twice and the function under test once. */
export const aMissionState = (patch: Partial<MissionState> = {}): MissionState => ({
  mission: aMission(),
  tasks: [],
  reports: [],
  verifications: {},
  leases: {},
  inbox: [],
  notes: [],
  workers: {},
  panicked: false,
  lastSeq: 1,
  ...patch,
});

export const missionCreated = (patch: Partial<EventInput> = {}): EventInput =>
  ({
    type: "mission_created",
    missionId: "m1",
    actor: "human",
    goal: "Add a /health endpoint",
    envelope: anEnvelope(),
    budget: aBudget(),
    unattended: false,
    ...patch,
  }) as EventInput;

/** A deterministic clock, so a fixture log is byte-identical between runs. */
export function fixedClock(startMs = Date.UTC(2026, 6, 25, 10, 0, 0), stepMs = 1000): () => string {
  let current = startMs;
  return () => {
    const at = new Date(current).toISOString();
    current += stepMs;
    return at;
  };
}

/** Stamp bare inputs with the envelope the log would add, for fold tests that do
 *  not need disk. Uses the same gapless `seq` rule the log enforces. */
export function stamp(inputs: readonly EventInput[], clock = fixedClock()): Event[] {
  // Parsed rather than cast, so a malformed fixture fails in the fixture instead of
  // three assertions later.
  return inputs.map((input, index) =>
    eventSchema.parse({ ...input, v: 1, seq: index + 1, at: clock() }),
  );
}

export interface Script {
  research?: ResearchResult[];
  plan?: PlannedTask[][];
  synthesize?: AgentSpec[];
  progress?: ProgressLedger[];
  judge?: JudgeResult[];
}

export interface ScriptedCalls extends Calls {
  /** How many times each decision point was reached. */
  readonly counts: Readonly<Record<keyof Calls, number>>;
}

/**
 * A `Calls` implementation that returns scripted answers in order. Running out of
 * script is an error rather than a repeat: a loop that spins forever on the last
 * canned answer is a test that passes for the wrong reason.
 */
export function scriptedCalls(script: Script): ScriptedCalls {
  const counts: Record<keyof Calls, number> = {
    research: 0,
    plan: 0,
    synthesize: 0,
    progress: 0,
    judge: 0,
  };

  const next = <T>(name: keyof Calls, queue: T[] | undefined): T => {
    const index = counts[name]++;
    const value = queue?.[index];
    if (value === undefined) {
      throw new Error(`scriptedCalls: no scripted '${name}' answer for call ${index + 1}.`);
    }
    return value;
  };

  return {
    counts,
    research: async () => next("research", script.research),
    plan: async () => next("plan", script.plan),
    synthesize: async () => next("synthesize", script.synthesize),
    progress: async () => next("progress", script.progress),
    judge: async () => next("judge", script.judge),
  };
}

export const zeroed = zeroSpend;
