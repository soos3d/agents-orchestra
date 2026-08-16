// The task contract. Git is a property of one worker kind, not of work in general —
// `branch`, `worktree`, and `owns` live on CodeTask and nowhere else.
import { z } from "zod";
import { artifactSchema, verifySpecSchema } from "./artifacts.js";

export const workerKindSchema = z.enum(["code", "research", "computer", "review", "general"]);

// `waiting` and `blocked` resume by different mechanisms and must not be one status:
// the scheduler resumes a dependency wait and nobody is told; only an answer resumes
// a human wait, and until then it belongs in the inbox.
export const taskStatusSchema = z.enum([
  "waiting",
  "todo",
  "blocked",
  "running",
  "verifying",
  "review",
  "done",
  "failed",
  "conflicted",
  "cancelled",
]);

export const TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export const transportRefSchema = z.object({
  id: z.enum(["agent-sdk", "cli", "acp", "chrome-mcp"]),
  target: z.string().optional(),
  model: z.string().optional(),
});

// Authored for THIS task at plan time (§7, amended), optionally starting from a role
// the roster already documents.
//
// §7 originally forbade a roster outright, on the argument that a fixed list caps the
// system at the tasks its author anticipated. The argument holds; the prohibition did
// not survive its cost, which was a full system prompt written from scratch for every
// task to reach a decision a one-line description already makes. So `basedOn` names a
// role from `src/agents/` and nothing about the ceiling moves: a spec is still checked
// against the mission envelope, the transport registry, and the lease rule in
// `loop/synthesize.ts` whether it named a role or invented one.
//
// `basedOn` is provenance rather than a pointer. By the time a spec is emitted,
// `systemPrompt` already holds the composed text — the role's body plus this task's
// addendum — so the log stays self-contained and nothing downstream resolves anything.
export const agentSpecSchema = z.object({
  role: z.string().min(1),
  systemPrompt: z.string().min(1),
  /** The roster role this spec started from, if any. Recorded so a mission can be read
   *  back to the role that shaped it; never read by the runtime. */
  basedOn: z.string().optional(),
  worker: workerKindSchema,
  transport: transportRefSchema,
  // Concrete tool names drawn from the catalogue, not class ids. Synthesis resolves a
  // class to tools and can only narrow (§4.0); validation maps each one back to its
  // class and checks that against the envelope.
  tools: z.array(z.string()),
  // The file lease this work declares (§8), and the reason it sits next to `tools`:
  // both are capabilities, one over the toolset and one over the tree, and both are
  // authored by the same call for the same task. Absent for every kind but `code`,
  // where it is required — an empty lease is not "no restriction", it is a lease that
  // matches nothing, which makes the post-hoc escape check fail every writing worker.
  owns: z.array(z.string()).optional(),
  // Where this agent's outputs go, relative to the per-task artifact directory the
  // runtime hands it (P2). Absent means the directory itself, which is the common
  // case. Relative on purpose: synthesis runs long before dispatch and the directory
  // is the runtime's to decide, so an absolute path here is a spec choosing its own
  // location — and it is refused at validation rather than at dispatch, the same door
  // as an undeclared lease. `z.string()` rather than a branded type for the same
  // reason `tools` is `z.array(z.string())`: an illegal declaration has to be
  // *representable* or the refusal is untestable.
  outputPath: z.string().optional(),
  // The environment variables this task needs, by name and never by value (defect 42).
  // The third capability on this spec, and it is checked the same way the other two
  // are: `tools` against the envelope's classes, `owns` against the other tasks'
  // leases, `env` against the envelope's granted names. Absent means the task gets
  // none of the mission's variables, which is the right answer for almost every task
  // — a worker still receives whatever its transport needs to start, and that list
  // lives beside the launch in `workers/`, not here and not in the envelope.
  env: z.array(z.string().min(1)).optional(),
  // Where this worker runs (PLAN-NEXT 3.2). Absent means "whatever the envelope says",
  // which is what almost every spec means and what every spec written before this field
  // existed meant. Present and weaker than the envelope — `"none"` under a `"container"`
  // mission — is refused at validation through the same door as an out-of-envelope tool.
  //
  // Representable rather than derived, for the reason `tools` is `z.array(z.string())`:
  // a spec asking to be let out of the sandbox has to be *expressible* or the refusal
  // cannot be tested, and a field the model cannot name is a ceiling nobody ever probes.
  containment: z.enum(["none", "container"]).optional(),
  model: z.string().min(1),
  verify: verifySpecSchema,
});

const taskBase = {
  id: z.string().min(1),
  missionId: z.string().min(1),
  // Full and self-contained: the worker sees nothing else.
  goal: z.string().min(1),
  successCriteria: z.array(z.string()),
  satisfies: z.array(z.string()),
  // Ledger entry ids. Populated from the start, because backfilling provenance is
  // not possible after the fact (§4.2).
  motivatedBy: z.array(z.string()),
  agentSpec: agentSpecSchema,
  dependsOn: z.array(z.string()),
  status: taskStatusSchema,
  artifacts: z.array(artifactSchema),
  verify: verifySpecSchema,
  attempts: z.number().int().nonnegative(),
  // The round this task last reached `done` in — folded, like `attempts`, from the
  // `task_status` transition rather than from an event of its own. It is what lets a
  // criterion checked `false` tell "nothing has landed since" from "the fix landed in
  // round 11": without it a false verdict is final, and the mission spins to its reset
  // cap with the fix already merged.
  completedRound: z.number().int().nonnegative().optional(),
  budget: z.object({
    wallMs: z.number().int().positive(),
    tokens: z.number().int().positive().optional(),
    dispatches: z.number().int().positive().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
};

export const codeTaskSchema = z.object({
  ...taskBase,
  worker: z.literal("code"),
  branch: z.string().min(1),
  worktree: z.string().optional(),
  owns: z.array(z.string()), // lease globs — §8
});

export const computerTaskSchema = z.object({
  ...taskBase,
  worker: z.literal("computer"),
  surface: z.enum(["browser", "desktop"]),
  allowedDomains: z.array(z.string()), // the computer analogue of a file lease — §11
});

export const plainTaskSchema = z.object({
  ...taskBase,
  worker: z.enum(["research", "review", "general"]),
});

export const taskSchema = z.discriminatedUnion("worker", [
  codeTaskSchema,
  computerTaskSchema,
  plainTaskSchema,
]);

export type WorkerKind = z.infer<typeof workerKindSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TransportRef = z.infer<typeof transportRefSchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type CodeTask = z.infer<typeof codeTaskSchema>;
export type ComputerTask = z.infer<typeof computerTaskSchema>;
export type Task = z.infer<typeof taskSchema>;

// A Task id. Named for readability at call sites that take several string lists.
export type TaskRef = string;

export const isCodeTask = (task: Task): task is CodeTask => task.worker === "code";
export const isComputerTask = (task: Task): task is ComputerTask => task.worker === "computer";
export const isTerminal = (status: TaskStatus): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);
