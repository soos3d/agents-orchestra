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
import { type Check } from "../config/doctor.js";
import { type Workspace, type WorkspaceProbe } from "../config/workspaces.js";

/**
 * The one frame that is not events and not a mission listing (UI plan U4): the
 * directories a mission may be composed in, the one currently being resolved, and
 * which of them are busy.
 *
 * It lives here rather than in `server.ts` because both sides read it and the browser
 * bundle must not import the server module even in type space. It is still not
 * rendered state — every field is a fact about the machine, and none of it is a view
 * of the mission log, which is the asymmetry this file's header is about.
 */
export interface WorkspacesFrame {
  workspaces: readonly Workspace[];
  pending: WorkspaceProbe | null;
  /** workspace id → the mission holding it. The per-directory cap, stated as data. */
  live: Readonly<Record<string, string>>;
  /** The workspace `compose` targets when it names none: where serve was launched. */
  defaultId: string;
}

/**
 * What `orchestra doctor` reports, on the page (UI plan U6).
 *
 * The same `doctor(config)` the command prints, so the browser and the terminal cannot
 * disagree about whether this machine is ready. `transports` is deliberately
 * `availableTransports` and not the built registry — offering a transport this machine
 * cannot start is defect 21, and a health panel that repeated the build's list would
 * reintroduce it as a display.
 *
 * Facts about the machine, never a view of a mission — which is what keeps it on the
 * right side of this file's asymmetry.
 */
export interface HealthFrame {
  checks: readonly Check[];
  ready: boolean;
  transports: readonly string[];
}

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

  // Answers a live worker's permission request (§12, `workers/acp`). Keyed by request
  // id rather than by task, because two workers can be waiting at once and a click on
  // one card must not answer the other. `approved` is a boolean and not a string on
  // purpose: `"false"` is truthy, and this is the message that hands a running agent a
  // capability nobody planned for it.
  z.object({
    kind: z.literal("resolve"),
    requestId: z.string().min(1),
    approved: z.boolean(),
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
    // Which directory it runs in (UI plan U4). An **id**, never a path: a mission-side
    // message that could carry a filesystem path is one edit away from putting a
    // browser-typed string in front of a process that spawns shells, and the shape is
    // where that is prevented. Absent means the directory serve was launched in.
    workspaceId: z.string().min(1).optional(),
    // Research, spec, plan, estimate — then stop, dispatching nothing (UI plan U6).
    // The CI flag, offered as a toggle because "show me what it would do" is the
    // question a person asks before their first real mission in a directory.
    planOnly: z.boolean().default(false),
    // Deliberately no `unattended` field: skipping sign-off stays a typed CLI flag
    // (§17 — the habitual-default risk), and the compose screen never offers it.
  }),
  z.object({ kind: z.literal("forget"), missionId: z.string().min(1) }),

  // Carry a parked mission on (UI plan U6). Distinct from `unpause`, which only lifts
  // a flag on a mission whose loop is still running: this one has no loop at all, and
  // starting it is what `orchestra resume` does from a terminal. Which directory it
  // runs in is the server's to decide from the mission's own envelope — a resume that
  // named a workspace would be a browser choosing a checkout for work already scoped
  // to one.
  z.object({ kind: z.literal("resume"), missionId: z.string().min(1) }),

  // Procedural memory (§6, §7), from the page: keep a finished mission to replay, or
  // keep one task's synthesized agent as prior art. Both are the exact mechanisms
  // `orchestra save` and `orchestra promote` use, and both stay human-initiated —
  // nothing in the loop sends either.
  z.object({
    kind: z.literal("save"),
    missionId: z.string().min(1),
    name: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("promote"),
    missionId: z.string().min(1),
    taskId: z.string().min(1),
    name: z.string().trim().min(1),
  }),

  // ── workspaces (UI plan U4) ──
  //
  // The two messages that *do* carry a path, and the split is the point: naming a
  // directory and using one are separate acts, so the step with consequences is the
  // step a human has to read. `workspace_probe` resolves and reports; `workspace_add`
  // confirms what was reported, and the server refuses an add whose path is not the
  // one it last showed. You cannot add a workspace you have not been shown.
  z.object({ kind: z.literal("workspace_probe"), path: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("workspace_add"),
    path: z.string().trim().min(1),
    /** Create the directory. False confirms an existing one; true is the act. */
    create: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("workspace_forget"), workspaceId: z.string().min(1) }),
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
