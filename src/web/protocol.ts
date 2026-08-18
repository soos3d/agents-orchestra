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
import { missionStaffingSchema } from "../domain/mission.js";

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
  /** The ways work can run on *this* machine, and the models each will accept
   *  (`workers/harness.ts`). The compose card renders these and sends back one of them;
   *  `isOfferedRuntime` refuses anything else. Same rule as `transports` above and for
   *  the same reason — a menu built from what the build ships rather than what the
   *  machine has is defect 21 as a display. */
  harnesses: readonly OfferedHarness[];
  /** The orchestrator's own model options. Separate from `harnesses` because the
   *  orchestrator has no harness choice at all: `runViaAgentSdk` *is* the Agent SDK, so
   *  the decision points are Anthropic-only and the page says so rather than showing an
   *  empty dropdown. */
  orchestratorModels: readonly string[];
  /** What the orchestrator runs on when a mission chooses nothing — `ORCHESTRATOR_MODEL`
   *  or its default. Reported because "which model is running this?" had no answer on
   *  the page at all, and the two constants below are the rest of that answer. */
  orchestratorModel: string;
  /** The model cards this machine has probed, which is the menu a decision point may be
   *  staffed from (PLAN-NEXT 4.3). Empty on every machine with no provider configured,
   *  and the compose card then offers no staffing control at all rather than an empty
   *  dropdown — the same rule as a harness nobody can start. */
  modelCards: readonly OfferedCard[];
  /** The models a human cannot pick, and what they are for: `progress` is a small
   *  judgment every round and `reformat` restates one JSON object, so both run cheap by
   *  design (§3, §4.1). Shown so the doctor panel does not imply one model runs
   *  everything. */
  fixedModels: readonly { readonly name: string; readonly model: string }[];
}

/** One row of the harness menu, flattened for the page: it renders these and never
 *  computes a cross-product of its own. */
export interface OfferedHarness {
  readonly id: string;
  readonly models: readonly string[];
  /** False on `acp/claude` and `acp/codex`, where the adapter picks its own model and is
   *  never told ours — but true on `acp/opencode`, which is sent one and refuses a name
   *  it does not have. Per row, from the launch that runs it (`AcpLaunch`). The
   *  page shows this as a note rather than hiding the control, because the choice is
   *  still recorded and still honoured the moment the same mission runs over `cli`. */
  readonly honoursModel: boolean;
}

/** One row of the model-card menu, flattened for the page. `tier` and `provider` are what
 *  the choice is actually made on — how strong it is and whose bill it lands on. */
export interface OfferedCard {
  readonly id: string;
  readonly tier: string;
  readonly provider: string;
}

/**
 * Whether a composed staffing names only cards the server offered — `isOfferedRuntime`'s
 * rule, one menu along (PLAN-NEXT 4.3).
 *
 * The same argument and a stronger version of it. A harness id decides which binary gets
 * spawned; a card id decides which provider this process posts a prompt and an API key to,
 * and there is no second gate behind it — `resolveStaffing` would refuse an unknown id, but
 * a browser must not be able to name one at all. Unlike the model menus, an empty card list
 * is never permissive: a card exists only because `orchestra doctor` reached it, so "no
 * cards" means no provider was ever probed here, and there is nothing a mission could
 * legitimately be staffed with.
 */
export function isOfferedStaffing(
  health: Pick<HealthFrame, "modelCards">,
  staffing: Readonly<Record<string, string | undefined>>,
): { ok: true } | { ok: false; problem: string } {
  const offered = health.modelCards.map((card) => card.id);

  for (const [call, id] of Object.entries(staffing)) {
    if (id === undefined) continue;
    if (!offered.includes(id)) {
      return {
        ok: false,
        problem:
          `no model card '${id}' to staff '${call}' with` +
          (offered.length > 0
            ? ` — offered: ${offered.join(", ")}.`
            : ` — this machine has probed no provider, so nothing can be staffed.`),
      };
    }
  }

  return { ok: true };
}

/**
 * Whether a composed runtime is one the server actually offered.
 *
 * Pure and here rather than in `server.ts`, per this file's own rule: what the server
 * *decides* is testable without a socket, and only the plumbing is not. The decision is
 * worth isolating because of what these strings become — `harness` selects which binary
 * is spawned and the two model fields become `--model` arguments and SDK options. A
 * browser must not be able to name any of them freely, so each is checked for membership
 * in a list this process computed, exactly as `workspace_add` is checked against the
 * path the server last reported.
 *
 * An **empty** model list on a harness means nothing is known about that vendor's models
 * (no `codex` menu has been verified), so a model may be named there and is not refused.
 * That is the one place this is permissive, and it is the honest reading rather than an
 * oversight: refusing every codex model to enforce the Anthropic half would fail correct
 * work.
 */
export function isOfferedRuntime(
  health: Pick<HealthFrame, "harnesses" | "orchestratorModels">,
  chosen: { harness?: string; workerModel?: string; orchestratorModel?: string },
): { ok: true } | { ok: false; problem: string } {
  const harness =
    chosen.harness === undefined
      ? undefined
      : health.harnesses.find((offered) => offered.id === chosen.harness);

  if (chosen.harness !== undefined && !harness) {
    const offered = health.harnesses.map((each) => each.id).join(", ");
    return {
      ok: false,
      problem:
        `no harness '${chosen.harness}' on this machine` +
        (offered ? ` — available: ${offered}.` : ` — no agent CLI is installed at all.`),
    };
  }

  if (chosen.workerModel !== undefined) {
    // With no harness pinned, any offered harness that could run the model is enough:
    // the mission is choosing a model, and synthesis still has to pick a harness that
    // agrees with it.
    const menus = harness ? [harness] : health.harnesses;
    const known = menus.flatMap((each) => [...each.models]);
    const unconstrained = menus.some((each) => each.models.length === 0);
    if (!unconstrained && !known.includes(chosen.workerModel)) {
      return {
        ok: false,
        problem:
          `no worker model '${chosen.workerModel}' on offer` +
          (known.length > 0 ? ` — available: ${[...new Set(known)].join(", ")}.` : `.`),
      };
    }
  }

  if (
    chosen.orchestratorModel !== undefined &&
    !health.orchestratorModels.includes(chosen.orchestratorModel)
  ) {
    return {
      ok: false,
      problem:
        `no orchestrator model '${chosen.orchestratorModel}' on offer — available: ` +
        `${health.orchestratorModels.join(", ")}.`,
    };
  }

  return { ok: true };
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

  // Open one thing this mission produced: a task's merged diff, or a file it wrote
  // (PLAN-NEXT 9.3). `id` is a **task id** or the `seq` of the event that recorded the
  // file — never a filename and never a path, which is `compose`'s `workspaceId` rule
  // applied to the one message that ends in `readFileSync`. The server rebuilds the
  // listing from its own log and refuses an id that is not in it (`web/work.ts`).
  //
  // Which mission is the server's to decide, from the socket's own cursor: there is no
  // `missionId` here on purpose, so a tab cannot read the artifacts of a mission it is
  // not watching.
  z.object({ kind: z.literal("show"), what: z.enum(["diff", "file"]), id: z.string().min(1) }),

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
    // The human's own judgment that this job is small: skip the deep research call and
    // ask the planner for one task rather than a decomposition. A boolean is safe to
    // accept from a browser in a way a path is not, and it is a *hint* rather than a
    // permission — `writeOutcomeSpec` still refuses an unverifiable spec, and a
    // scan-derived spec that fails it escalates to the research call it skipped.
    quick: z.boolean().default(false),
    // The opposite judgment, and the same kind of value: a boolean is safe to accept
    // from a browser in a way a path is not, and it grants nothing — it turns up two
    // knobs the loop already has (a second critic round, and a critic shown the design
    // note). Refused together with `quick` below, where the CLI refuses the same pair.
    moonshot: z.boolean().default(false),
    // How this mission runs (`domain/mission.ts` `missionRuntimeSchema`). Three strings
    // and the shape is where their safety comes from — the same argument that makes
    // `workspaceId` an id and never a path.
    //
    // A model name reaches `--model` on a spawned CLI and a harness id decides which
    // binary is spawned, so neither may be free text from a browser. They are checked
    // against what the server itself computed and last sent in `HealthFrame`, which is
    // `workspace_add`'s rule applied to a runtime: **you cannot choose a harness you
    // have not been shown**. The check is `isOfferedRuntime` and it lives in this file,
    // beside the schema, because the schema alone cannot know what this machine has.
    harness: z.string().trim().min(1).optional(),
    workerModel: z.string().trim().min(1).optional(),
    orchestratorModel: z.string().trim().min(1).optional(),
    // Which decision points run on a model card (PLAN-NEXT 4.3). The schema bounds the
    // *shape* — five known keys, no `judge` — and `isOfferedStaffing` bounds the values
    // against the cards this server probed, because a card id is what decides which
    // provider gets sent a prompt and a key.
    staffing: missionStaffingSchema.default({}),
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
