// What an inbox item looks like by the time it leaves the machine (§10, §17).
//
// The never-mirrored rules are enforced here, at construction, rather than in any
// carrier: a `credential`-class gate is refused outright — a human handles those at
// the real surface, and a card that even names one is a card someone can approve by
// reflex — and no card carries a screenshot path or image. Until Phase 8's
// redaction-at-capture exists there is no such thing as a screenshot that is safe
// to send, so the rule is structural: the card type has no field to put one in.
import { type Event } from "../events/schema.js";

export interface GateCard {
  itemId: string;
  /** `notice` is outbound-only — a card that expects no reply, like telling the
   *  bound user their channel just refused an impostor (§17). */
  kind: "question" | "gate" | "budget_extension" | "notice";
  /** Plain language, self-contained: the phone shows this and nothing else. */
  caption: string;
  nonce: string;
  missionId: string;
}

export type BuiltCard = { ok: true; card: GateCard } | { ok: false; reason: string };

export function buildCard(event: Event, nonce: string): BuiltCard {
  if (event.type === "question_asked") {
    return {
      ok: true,
      card: {
        itemId: event.questionId,
        kind: "question",
        caption: event.question,
        nonce,
        missionId: event.missionId,
      },
    };
  }

  if (event.type === "gate_requested") {
    if (event.actionClass === "credential") {
      return {
        ok: false,
        reason:
          "credential-class actions are never mirrored (§17); this gate waits for a " +
          "human at the local dashboard.",
      };
    }
    return {
      ok: true,
      // The screenshot stays on the machine: the card names the action and the
      // dashboard shows the pixels.
      card: {
        itemId: event.gateId,
        kind: "gate",
        caption: `${event.description} — full detail and screenshot on the local dashboard.`,
        nonce,
        missionId: event.missionId,
      },
    };
  }

  if (event.type === "budget_exceeded" && event.scope === "mission") {
    return {
      ok: true,
      card: {
        itemId: `budget-${event.seq}`,
        kind: "budget_extension",
        caption: `Mission budget exhausted after ${Math.round(event.actual.wallMs / 60000)} min. Extend?`,
        nonce,
        missionId: event.missionId,
      },
    };
  }

  return { ok: false, reason: `a '${event.type}' event is not an inbox item and has no card.` };
}
