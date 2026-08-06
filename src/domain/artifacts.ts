// What work produces, how it gets checked, and what makes a check auditable.
//
// The orchestrator sees artifact metadata and short worker reports only — never a
// full transcript, never raw stdout. That context discipline is what lets a mission
// run for hours without drowning.
import { z } from "zod";

export const artifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("diff"),
    id: z.string(),
    branch: z.string(),
    files: z.array(z.string()),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("document"), id: z.string(), path: z.string(), summary: z.string() }),
  z.object({
    kind: z.literal("data"),
    id: z.string(),
    path: z.string(),
    schema: z.string().optional(),
  }),
  // Referenced by path, never inlined: a base64 screenshot per browser action would
  // make the log unreplayable within one mission (§9.1).
  z.object({
    kind: z.literal("screenshot"),
    id: z.string(),
    path: z.string(),
    caption: z.string(),
  }),
  z.object({ kind: z.literal("report"), id: z.string(), text: z.string() }),
]);

export const verifySpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    command: z.string().min(1),
    cwd: z.enum(["worktree", "repo"]).optional(),
  }),
  z.object({ kind: z.literal("judge"), rubric: z.string().min(1), agent: z.string().optional() }),
  // The only kind that has to argue for itself.
  z.object({ kind: z.literal("none"), reason: z.string().min(1) }),
]);

// What makes `met: true` auditable rather than a model's assertion.
export const evidenceSchema = z.object({
  artifactIds: z.array(z.string()),
  checkOutput: z.string(),
  reasoning: z.string(),
  byTask: z.array(z.string()),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type VerifySpec = z.infer<typeof verifySpecSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
