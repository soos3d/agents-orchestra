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

// Synthesized for THIS task at plan time (§7), never chosen from a fixed roster.
export const agentSpecSchema = z.object({
  role: z.string().min(1),
  systemPrompt: z.string().min(1),
  worker: workerKindSchema,
  transport: transportRefSchema,
  tools: z.array(z.string()),
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
