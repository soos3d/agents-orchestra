// The one place a *running* worker waits on a person, and the bookkeeping that makes
// that wait safe.
//
// `permissions.ts` decides whether a live agent's tool call is already covered by its
// grant; when the answer is `ask`, this is what carries the question to a human and the
// answer back. ACP's permission channel is what replaces the blanket
// `--dangerously-skip-permissions` the CLI transport lives with (§12, defect 14), and
// the request lands in the one inbox alongside questions and gates (§10) rather than
// in a surface of its own.
//
// **A mid-run await that two surfaces can answer is where races live**, so there is
// exactly one writer and exactly one settle. Every resolution — a terminal `y`, a
// dashboard click, a carrier reply — goes through `resolve`, which deletes the pending
// entry *before* it emits, so a request cannot be recorded twice on the log or hand two
// answers to a worker that asked once. A resolution for an id nothing is waiting on is
// dropped with a warning and never a throw: a second surface answering late is normal
// (the same human reachable two ways), and a socket handler that throws takes the
// server down with it.
//
// A surface *rejecting* is not a denial. The terminal port rejects when standard input
// ended, precisely so a browser can still win the race ("end of input is not
// approval"), so a rejection here leaves the request open for whoever else is listening.
// The one case that resolves without a human is having no human at all: under
// `--unattended` the request is denied immediately and the denial carries its reason,
// because a worker blocked on nobody costs the whole session and tells the replan
// nothing (§9.4's shape — running out of a resource is an answer, not a hang).
//
// **There is no clock here, deliberately.** The port never times out on its own; the
// ACP session's own timeout is what bounds the wait. A second timer would race the
// first, and the one that fired would leave the other's promise unsettled.
import { type EventInput } from "../../events/schema.js";
import { redact, type Secret } from "../redact.js";
import { type PermissionRequest } from "./permissions.js";

/** What a surface is shown. `requestId` rides along because the answer comes back by
 *  id — a dashboard may be looking at two requests from two tasks at once. */
export interface PermissionAsk extends PermissionRequest {
  requestId: string;
  taskId: string;
}

export interface PermissionPortDeps {
  emit(input: EventInput): void;
  missionId: string;
  /**
   * The human, however many surfaces they have — `anyOf` has already combined them by
   * the time this is bound. Absent means nobody is there, which is what `--unattended`
   * amounts to, and an absent asker denies rather than waits.
   */
  ask?: (request: PermissionAsk) => Promise<boolean>;
  /**
   * The values of the variables this mission granted (PLAN-NEXT 7.3).
   *
   * A permission request quotes the tool call it is asking about, and an agent holding a
   * credential writes it into the call — `curl -H "Authorization: Bearer …"` is the
   * ordinary shape of the request this channel exists for. `detail` is emitted as
   * `permission_requested` and rendered on whatever surface answers, so it is scrubbed
   * once here, before either. The human loses nothing: `[redacted:STRIPE_KEY]` says
   * exactly what is in the call, which is what they are deciding about.
   */
  secrets?: readonly Secret[];
  onWarn?: (message: string) => void;
}

export interface PermissionPort {
  /** What the ACP transport calls. `true` allows the tool call, `false` rejects it. */
  requestPermission(taskId: string, request: PermissionRequest): Promise<boolean>;
  /** The handle every surface answers through. `false` means nothing was waiting on
   *  that id, which the caller reports rather than swallowing. */
  resolve(requestId: string, approved: boolean, reason?: string): boolean;
  /** Open request ids, for a composition root that has to say what a mission is
   *  waiting on. */
  pending(): readonly string[];
}

export function createPermissionPort(deps: PermissionPortDeps): PermissionPort {
  const waiting = new Map<string, (approved: boolean) => void>();
  let issued = 0;

  const resolve = (requestId: string, approved: boolean, reason?: string): boolean => {
    const settle = waiting.get(requestId);
    if (!settle) {
      deps.onWarn?.(
        `No open permission request '${requestId}' — ignoring this answer. ` +
          "It was already resolved, or it belongs to a mission that has moved on; " +
          "nothing to fix unless a worker is still waiting, in which case answer the " +
          "request the inbox is showing.",
      );
      return false;
    }

    // Deleted before the emit, so a re-entrant surface cannot record a second
    // resolution for a request that is already answered.
    waiting.delete(requestId);
    deps.emit({
      type: "permission_resolved",
      missionId: deps.missionId,
      actor: "human",
      requestId,
      approved,
      ...(reason === undefined ? {} : { reason }),
    });
    settle(approved);
    return true;
  };

  return {
    resolve,
    pending: () => [...waiting.keys()],

    requestPermission(taskId: string, incoming: PermissionRequest): Promise<boolean> {
      const requestId = `perm-${taskId}-${++issued}`;
      const request: PermissionRequest = {
        ...incoming,
        // Both fields, not just the detail. OpenCode's permission frame carries no tool
        // name and its later updates rewrite the title to *what the tool is doing* —
        // `bash` became `ls -la` in the capture — so `tool` is a command string often
        // enough that scrubbing one of the two would be arbitrary.
        tool: redact(incoming.tool, deps.secrets ?? []),
        detail: redact(incoming.detail, deps.secrets ?? []),
      };

      deps.emit({
        type: "permission_requested",
        missionId: deps.missionId,
        taskId,
        actor: "worker",
        requestId,
        tool: request.tool,
        detail: request.detail,
      });

      const decision = new Promise<boolean>((settle) => waiting.set(requestId, settle));

      if (!deps.ask) {
        resolve(
          requestId,
          false,
          `Nobody was there to ask (unattended): '${request.tool}' was not in the ` +
            "agent's grant, and no surface could widen it. Re-run attended, or plan a " +
            "task whose synthesized spec is granted the tool it needs.",
        );
        return decision;
      }

      void deps.ask({ requestId, taskId, ...request }).then(
        (approved) => {
          // Guarded rather than assumed: another surface may already have answered
          // while this one was being read.
          if (waiting.has(requestId)) resolve(requestId, approved);
        },
        (error: unknown) => {
          // Not a denial. This surface cannot answer — another one still can, and the
          // session's own timeout is what bounds the wait if none does.
          deps.onWarn?.(
            `No answer from that surface for permission '${requestId}': ` +
              `${error instanceof Error ? error.message : String(error)} ` +
              "The request stays open; answer it from the dashboard.",
          );
        },
      );

      return decision;
    },
  };
}
