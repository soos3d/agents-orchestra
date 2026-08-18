// The `HumanPort` backed by a browser tab.
//
// Same interface the terminal implements, so `prepareMission` cannot tell them apart
// — which is the reason the port exists at all. What differs is only how long the
// promise stays open: a terminal blocks a process on a person who is at the keyboard,
// and this blocks on one who may be asleep. Both are correct, and the mission is
// `awaiting_signoff` on disk either way.
//
// A decision that arrives with nothing pending is dropped rather than remembered.
// Queuing it would mean a stale tab's leftover "approve" — clicked before a restart,
// replayed after — approving the *next* thing the mission asks about, which is a
// different plan than the one anybody looked at.
import { type IntakeQuestion } from "../loop/calls.js";
import {
  type HumanPort,
  type IntakeAnswer,
  type SignoffDecision,
  type SignoffPresentation,
} from "../loop/human.js";
import { type PermissionAsk } from "../workers/acp/permissionPort.js";
import { type ClientMessage } from "./protocol.js";

export interface WebHuman extends HumanPort {
  /** Routes a validated client message to whatever is waiting. False means nothing
   *  was, which the caller reports rather than swallowing. */
  deliver(message: ClientMessage): boolean;
  /** What the mission is currently blocked on, for the page to render. */
  pending(): "signoff" | "intake" | undefined;
}

export function createWebHuman(): WebHuman {
  let onSignoff: ((decision: SignoffDecision) => void) | undefined;
  let onIntake: ((answers: IntakeAnswer[]) => void) | undefined;
  // Keyed, where the two above are not: sign-off and intake happen once and block the
  // mission, but two live workers can be waiting on two permission requests at the
  // same time (§12). A single slot would let a click on one card answer the other.
  const onPermission = new Map<string, (approved: boolean) => void>();

  return {
    pending: () => (onSignoff ? "signoff" : onIntake ? "intake" : undefined),

    askIntake: (_questions: readonly IntakeQuestion[]) =>
      new Promise<IntakeAnswer[]>((resolve) => {
        onIntake = resolve;
      }),

    // Never rejects and never times out. A worker is awaiting this, and the human may
    // be asleep; the ACP session's own timeout is what bounds the wait (§12), which is
    // the same reason the permission port has no clock of its own.
    askPermission: (request: PermissionAsk) =>
      new Promise<boolean>((resolve) => {
        onPermission.set(request.requestId, resolve);
      }),

    awaitSignoff: (_presentation: SignoffPresentation) =>
      new Promise<SignoffDecision>((resolve) => {
        onSignoff = resolve;
      }),

    deliver(message: ClientMessage): boolean {
      // Cleared before resolving, not after. `resolve` hands control to whatever was
      // awaiting, and that continuation can reach `askIntake` again on the same tick —
      // clearing afterwards would wipe the *new* pending answer and hang the mission.
      if (message.kind === "approve" || message.kind === "revise") {
        const waiting = onSignoff;
        if (!waiting) return false;
        onSignoff = undefined;
        waiting(
          message.kind === "approve"
            ? { kind: "approve" }
            : { kind: "revise", feedback: message.feedback },
        );
        return true;
      }

      if (message.kind === "resolve") {
        const waiting = onPermission.get(message.requestId);
        if (!waiting) return false;
        onPermission.delete(message.requestId);
        waiting(message.approved);
        return true;
      }

      if (message.kind === "intake") {
        const waiting = onIntake;
        if (!waiting) return false;
        onIntake = undefined;
        waiting([...message.answers]);
        return true;
      }

      return false;
    },
  };
}
