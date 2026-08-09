// What the browser is allowed to say to the orchestrator.
//
// Validated with zod at the socket, which is a boundary in exactly the sense the
// project means: input from outside the process, parsed once, never trusted. The
// server binds to loopback, but "only I can reach it" is an argument about the
// network and not about the bytes — a malformed frame from a stale tab reaches the
// same handler as a good one.
//
// Deliberately small, and the asymmetry is the design. The server sends *events* and
// nothing else: the log is the source of truth (§9.1), so the page folds the same
// events the orchestrator does and renders from that. A server that sent rendered
// state would be a second reducer, free to disagree with `fold` about what a human is
// looking at — which, on the screen where somebody approves a payment gate, is the
// disagreement that matters.
//
// So the browser sends decisions, never state.
import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("revise"), feedback: z.string().min(1) }),
  z.object({
    kind: z.literal("intake"),
    answers: z.array(z.object({ questionId: z.string().min(1), answer: z.string() })),
  }),
  z.object({
    kind: z.literal("note"),
    scope: z.enum(["global", "task"]),
    taskId: z.string().optional(),
    text: z.string().min(1),
    missionId: z.string().optional(),
  }),
  z.object({ kind: z.literal("panic"), reason: z.string().default("panic from the dashboard") }),
  // Answers an `ask_human` question (§10). Distinct from `intake`: intake resolves a
  // port that is awaiting, an answer resolves an inbox item on the log — the mission
  // may be parked with no loop running when it arrives. `missionId` is how a serve
  // dashboard answers a mission that is parked rather than live.
  z.object({
    kind: z.literal("answer"),
    questionId: z.string().min(1),
    answer: z.string().min(1),
    missionId: z.string().optional(),
  }),

  // Pause drains and parks; unpause lifts the flag so a resume carries on (§10).
  // Panic stays its own message because it is not a stronger pause.
  z.object({ kind: z.literal("pause"), missionId: z.string().optional() }),
  z.object({ kind: z.literal("unpause"), missionId: z.string().optional() }),

  // ── serve only (§13). A per-run server rejects these: it has one mission and no
  // registry, and "compose" landing on it would start a second mission inside a
  // process whose lifetime belongs to the first. ──
  z.object({ kind: z.literal("watch"), missionId: z.string().min(1) }),
  z.object({
    kind: z.literal("compose"),
    goal: z.string().trim().min(1),
    budgetMinutes: z.number().positive().optional(),
    // Deliberately no `unattended` field: skipping sign-off stays a typed CLI flag
    // (§17 — the habitual-default risk), and the compose screen never offers it.
  }),
  z.object({ kind: z.literal("forget"), missionId: z.string().min(1) }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ParsedMessage = { ok: true; message: ClientMessage } | { ok: false; problem: string };

/**
 * `safeParse` plus a hand-written message rather than `.parse()`, per the project's
 * boundary rule: a thrown ZodError on a socket handler takes the server down with it,
 * and the tab that sent the bad frame is the one place that cannot report the problem.
 */
export function parseClientMessage(raw: string): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, problem: "the frame is not JSON." };
  }

  const result = clientMessageSchema.safeParse(json);
  if (result.success) return { ok: true, message: result.data };

  const issue = result.error.issues[0];
  return {
    ok: false,
    problem: `${issue?.path.join(".") || "kind"}: ${issue?.message ?? "unrecognised message"}.`,
  };
}
