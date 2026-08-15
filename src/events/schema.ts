// The event schema (§9.1). The most load-bearing type in the system: resume
// correctness is entirely a function of this union, so it is written before
// anything emits rather than discovered while debugging a replay.
//
// Two rules are visible in the shapes below and matter more than any single field:
// every state transition is an event, and events carry *values* rather than
// references to mutable state — `task_planned` embeds the whole Task, so replay
// never depends on a file that could have been edited since.
import { z } from "zod";
import { budgetSchema, spendSchema } from "../domain/budget.js";
import { artifactSchema, evidenceSchema, verifySpecSchema } from "../domain/artifacts.js";
import { envelopeSchema } from "../domain/envelope.js";
import {
  criterionDiffSchema,
  criterionSchema,
  deadEndSchema,
  factSchema,
  findingSchema,
  guessSchema,
  progressLedgerSchema,
  taskLedgerSchema,
} from "../domain/ledger.js";
import { estimateSchema, missionStatusSchema } from "../domain/mission.js";
import {
  agentSpecSchema,
  taskSchema,
  taskStatusSchema,
  transportRefSchema,
  workerKindSchema,
} from "../domain/task.js";
import { workerReportSchema } from "../domain/report.js";

export const SCHEMA_VERSION = 1;

export const eventBaseSchema = z.object({
  v: z.literal(SCHEMA_VERSION),
  // Monotonic per mission, gapless. The replay ordering key; a gap is corruption.
  seq: z.number().int().positive(),
  at: z.string().min(1),
  missionId: z.string().min(1),
  taskId: z.string().optional(),
  actor: z.enum(["orchestrator", "worker", "human", "runtime"]),
});

const withBase = <T extends z.ZodRawShape>(shape: T) => eventBaseSchema.extend(shape);

const missionLifecycle = [
  withBase({
    type: z.literal("mission_created"),
    goal: z.string(),
    envelope: envelopeSchema,
    budget: budgetSchema,
    unattended: z.boolean(),
    // The human's own judgment, at compose time, that this job is small: skip the deep
    // research call and plan one task rather than a decomposition. It belongs on the
    // mission rather than in a runtime option because `orchestra resume` rebuilds
    // everything it knows from the log — a flag held only in process memory would
    // silently change a mission's shape when it was carried on the next morning.
    //
    // Optional so a log written before this field replays unchanged, which is what
    // the committed receipt in `src/testing/receipts/` asserts.
    quick: z.boolean().optional(),
  }),
  withBase({
    type: z.literal("mission_status"),
    from: missionStatusSchema,
    to: missionStatusSchema,
    reason: z.string(),
  }),
  withBase({
    type: z.literal("scan_completed"),
    findings: z.array(findingSchema),
    spend: spendSchema,
  }),
  withBase({
    type: z.literal("intake_question"),
    questionId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
  withBase({ type: z.literal("intake_answered"), questionId: z.string(), answer: z.string() }),
  withBase({
    type: z.literal("research_completed"),
    brief: z.string(),
    findings: z.array(findingSchema),
    // Which pass produced this. A `quick` mission (the compose checkbox) skips the
    // deep call and keeps the scan's own answer, so the event still carries a brief —
    // the briefing's research row finishes on that — while saying plainly that the
    // ground was covered once and lightly. Optional so an older log replays unchanged.
    depth: z.enum(["scan", "deep"]).optional(),
    spend: spendSchema,
  }),
] as const;

const contract = [
  withBase({
    type: z.literal("outcome_spec_written"),
    criteria: z.array(criterionSchema),
    guesses: z.array(guessSchema),
    outOfScope: z.array(z.string()),
    estimate: estimateSchema,
  }),
  withBase({
    type: z.literal("outcome_spec_rejected"),
    rejected: z.array(z.object({ criterion: z.string(), reason: z.string() })),
  }),
  withBase({ type: z.literal("signoff_requested"), estimate: estimateSchema }),
  withBase({ type: z.literal("signoff_granted"), unattended: z.boolean() }),
  withBase({ type: z.literal("signoff_revised"), feedback: z.string() }),
  withBase({
    type: z.literal("criteria_change_requested"),
    diff: z.array(criterionDiffSchema),
    reasoning: z.string(),
  }),
  withBase({ type: z.literal("criteria_change_resolved"), approved: z.boolean() }),
] as const;

const loop = [
  withBase({ type: z.literal("round_started"), round: z.number().int().nonnegative() }),
  withBase({
    type: z.literal("ledger_revised"),
    ledger: taskLedgerSchema,
    // Adding a member is backward-compatible: an old log never carries it, and the
    // meaning of the existing ones is unchanged, so this is not a `v` bump (§9.1).
    reason: z.enum(["replan", "note", "research", "spec", "intake", "saved"]),
  }),
  withBase({
    type: z.literal("progress_ledger"),
    round: z.number().int().nonnegative(),
    ledger: progressLedgerSchema,
  }),
  withBase({ type: z.literal("stall_detected"), stalls: z.number().int().nonnegative() }),
  withBase({
    type: z.literal("replan_started"),
    resets: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  withBase({ type: z.literal("dead_end_added"), deadEnd: deadEndSchema }),
  // Semantic memory entering the mission (§6). The recalled entries are carried whole
  // rather than as lore ids, because a lore file is a plain markdown file a human may
  // edit or delete between now and the replay — and §9.1 rule 2 says an event may not
  // depend on one. `consulted` is how many entries the store held, so a mission that
  // recalled nothing is distinguishable from one that never looked.
  withBase({
    type: z.literal("memory_recalled"),
    facts: z.array(factSchema),
    guesses: z.array(guessSchema),
    consulted: z.number().int().nonnegative(),
  }),
  // The write-back's audit trail. Memory is files a human can read and delete (§6),
  // so the log names the ones a mission wrote rather than leaving them anonymous.
  withBase({ type: z.literal("memory_written"), path: z.string(), loreType: z.string() }),
] as const;

const tasks = [
  withBase({ type: z.literal("task_planned"), task: taskSchema }),
  // A replan redefined a task that already exists (defect 26). The revised plan lives
  // in the ledger, but the scheduler reads *task records* — a changed `dependsOn`
  // that never reaches them leaves the dependents of a failed task waiting forever.
  // Carries the whole updated Task, like task_planned, per replay rule 2.
  withBase({ type: z.literal("task_replanned"), task: taskSchema }),
  withBase({
    type: z.literal("task_status"),
    from: taskStatusSchema,
    to: taskStatusSchema,
    reason: z.string(),
  }),
  withBase({ type: z.literal("lease_granted"), owns: z.array(z.string()) }),
  withBase({
    type: z.literal("lease_rejected"),
    owns: z.array(z.string()),
    conflictsWith: z.string(),
  }),
  withBase({
    type: z.literal("lease_escaped"),
    declared: z.array(z.string()),
    touched: z.array(z.string()),
  }),
  // Defect 41: a worker with no worktree edited the shared checkout. Deliberately not
  // a `lease_escaped` with `declared: []` — an empty lease already means "a lease that
  // matches nothing" (defect 23), so overloading the event would make every reader tell
  // "wrote outside what it declared" apart from "declared nothing because §4 gives git
  // only to `code` tasks". Those are different mistakes with different fixes, which is
  // the `waiting`/`blocked` argument (§4) one event over.
  withBase({
    type: z.literal("repo_escaped"),
    worker: workerKindSchema,
    touched: z.array(z.string()),
  }),
  withBase({
    type: z.literal("worker_started"),
    agentSpec: agentSpecSchema,
    transport: transportRefSchema,
    pid: z.number().int().optional(),
  }),
  withBase({ type: z.literal("worker_heartbeat") }),
  withBase({ type: z.literal("worker_report"), report: workerReportSchema }),
  withBase({ type: z.literal("artifact_written"), artifact: artifactSchema }),
  withBase({
    type: z.literal("verification_run"),
    spec: verifySpecSchema,
    passed: z.boolean(),
    output: z.string(),
  }),
  withBase({
    type: z.literal("criterion_checked"),
    criterionId: z.string(),
    met: z.boolean(),
    evidence: evidenceSchema,
  }),
] as const;

const git = [
  withBase({
    type: z.literal("worktree_created"),
    path: z.string(),
    branch: z.string(),
    baseSha: z.string(),
  }),
  withBase({ type: z.literal("worktree_removed"), path: z.string() }),
  withBase({ type: z.literal("merge_started"), branch: z.string(), intoSha: z.string() }),
  withBase({ type: z.literal("merge_completed"), branch: z.string(), resultSha: z.string() }),
  withBase({
    type: z.literal("merge_conflicted"),
    branch: z.string(),
    files: z.array(z.string()),
  }),
  // Defect 31: a branch with no commits merges cleanly and changes nothing, so
  // without its own event the log's only record of a task whose work never landed is
  // a `merge_completed` whose result sha equals the base — which is what a green log
  // over destroyed work looks like.
  withBase({ type: z.literal("merge_empty"), branch: z.string(), reason: z.string() }),
] as const;

const humanChannel = [
  withBase({
    type: z.literal("note_received"),
    scope: z.enum(["global", "task"]),
    text: z.string(),
  }),
  withBase({
    type: z.literal("note_delivered"),
    scope: z.enum(["global", "task"]),
    path: z.enum(["stream", "tool_result", "dispatch"]),
  }),
  withBase({
    type: z.literal("question_asked"),
    questionId: z.string(),
    question: z.string(),
    blocks: z.array(z.string()),
  }),
  withBase({
    type: z.literal("question_answered"),
    questionId: z.string(),
    answer: z.string(),
  }),
  withBase({
    type: z.literal("gate_requested"),
    gateId: z.string(),
    actionClass: z.enum(["commit", "credential"]),
    description: z.string(),
    screenshotPath: z.string(),
  }),
  withBase({
    type: z.literal("gate_resolved"),
    gateId: z.string(),
    approved: z.boolean(),
    by: z.string(),
  }),
  withBase({
    type: z.literal("permission_requested"),
    requestId: z.string(),
    tool: z.string(),
    detail: z.string(),
  }),
  withBase({
    type: z.literal("permission_resolved"),
    requestId: z.string(),
    approved: z.boolean(),
    // Why, when the answer was not a person's: an unattended mission denies rather
    // than waiting on nobody, and a replan that cannot see the reason re-proposes the
    // task that needed the tool. Optional, because a human clicking "allow" has said
    // everything there is to say.
    reason: z.string().optional(),
  }),
  withBase({
    type: z.literal("envelope_violation"),
    requested: z.string(),
    envelope: envelopeSchema,
  }),
] as const;

const runtime = [
  // `model` is what actually produced this spend, when the transport says — which is
  // not always what the spec asked for: `AgentSpec.model` is never sent over ACP, so a
  // task planned for one model can run on another. Optional because most transports do
  // not say, and a cost cannot be priced against a model nobody recorded.
  withBase({
    type: z.literal("spend_recorded"),
    phase: z.string(),
    spend: spendSchema,
    model: z.string().min(1).optional(),
  }),
  withBase({
    type: z.literal("budget_exceeded"),
    scope: z.enum(["task", "mission"]),
    limit: budgetSchema,
    actual: spendSchema,
  }),
  withBase({
    type: z.literal("budget_extended"),
    added: budgetSchema,
    extensions: z.number().int().nonnegative(),
    by: z.string(),
  }),
  withBase({ type: z.literal("shutdown"), signal: z.string(), resumeCommand: z.string() }),
  withBase({
    type: z.literal("resumed"),
    fromSeq: z.number().int().nonnegative(),
    orphans: z.array(z.object({ taskId: z.string(), action: z.string() })),
  }),
  withBase({ type: z.literal("panic"), reason: z.string(), by: z.string() }),
  // Pause is not panic (§10): it drains rather than kills, and it is reversible.
  // Two events rather than a toggle payload, so a replay cannot misread which one
  // it is looking at.
  withBase({ type: z.literal("pause_requested"), by: z.string() }),
  withBase({ type: z.literal("pause_lifted"), by: z.string() }),
] as const;

export const eventSchema = z.discriminatedUnion("type", [
  ...missionLifecycle,
  ...contract,
  ...loop,
  ...tasks,
  ...git,
  ...humanChannel,
  ...runtime,
]);

export type Event = z.infer<typeof eventSchema>;
export type EventType = Event["type"];

// Distributive, so the union survives: every member loses the same three fields
// rather than collapsing into one intersected shape.
type StripEnvelope<T> = T extends unknown ? Omit<T, "v" | "seq" | "at"> : never;
export type EventInput = StripEnvelope<Event>;

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  eventSchema.options.map((option) => option.shape.type.value),
);

// Read loosely first: an unknown `type` must be skippable with a warning, which is
// impossible if the only parser available rejects the whole line.
export const envelopeOnlySchema = z.object({
  v: z.number(),
  seq: z.number(),
  type: z.string(),
});
