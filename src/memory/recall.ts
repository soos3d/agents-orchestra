// The translation between semantic memory (§6) and the task ledger (§3), in both
// directions. Pure — no disk, no clock of its own — because both directions encode a
// rule that has to be assertable without a filesystem.
//
// Inbound, the rule is §6's: a stale fact enters the ledger as a `Guess` and never as
// a `factVerified`. The two ledger tiers are treated very differently by a replan, and
// promoting a fact nobody re-checked into the tier the planner trusts is exactly how a
// wrong memory quietly biases every future plan.
//
// Outbound, the rule is "no automatic learning". Promotion is deliberately weak: a
// verified fact leaves as a *low*-confidence observation on a seven-day clock rather
// than a 30-day one, so anything that survives does so by being re-observed rather
// than by being asserted once. And a fact that came *from* memory is never promoted
// back into it — that loop would reset the staling clock on every recall and turn a
// cache into a belief.
//
// Ids are allocated by prefix and index rather than taken from the lore entry, because
// `motivatedBy` names ledger entries by id (§4.2) and a lore id colliding with an
// existing `f3` would point a task's provenance at the wrong thing. The caller owns
// numbering through `startIndex`, the way `answersAsFacts` does for intake.
import { type Fact, type Guess } from "../domain/ledger.js";
import { type MissionState } from "../events/fold.js";
import { type LoreEntry } from "./lore.js";

/** How long a promoted observation is trusted before it must be re-observed. Shorter
 *  than §6's 30-day default on purpose: the system wrote this one about itself. */
export const PROMOTED_STALE_AFTER_DAYS = 7;

const FACT_PREFIX = "m";
const GUESS_PREFIX = "mg";

export interface RecallOptions {
  /** The round the entries are recorded against. */
  addedRound?: number;
  /** Ids continue from here, so a caller that has already allocated `m1..m4` passes 4. */
  startIndex?: number;
}

export interface RecalledLedger {
  facts: Fact[];
  guesses: Guess[];
}

const day = (iso: string): string => iso.slice(0, 10);

/**
 * What memory contributes to a mission's ledger.
 *
 * `at` is when the recall happened, not when the claim was observed: a recalled fact
 * keeps the lore entry's own `observedAt`, because that timestamp is what the staling
 * clock was measured against and rewriting it would make every recalled fact look new.
 */
export function recallToLedger(
  fresh: readonly LoreEntry[],
  stale: readonly LoreEntry[],
  at: string,
  options: RecallOptions = {},
): RecalledLedger {
  const addedRound = options.addedRound ?? 0;
  const start = options.startIndex ?? 0;

  const facts: Fact[] = fresh.map((entry, index) => ({
    id: `${FACT_PREFIX}${start + index + 1}`,
    text: entry.claim,
    addedRound,
    source: { kind: "memory", ref: entry.id },
    observedAt: entry.observedAt,
  }));

  const guesses: Guess[] = stale.map((entry, index) => ({
    id: `${GUESS_PREFIX}${start + index + 1}`,
    text: entry.claim,
    addedRound,
    confidence: "low",
    basis:
      `stale ${entry.type} lore ${entry.id}, observed ${day(entry.observedAt)} ` +
      `and recalled ${day(at)} — re-verify before relying on it`,
  }));

  return { facts, guesses };
}

/**
 * What a mission contributes back to memory (§6).
 *
 * Pure: it returns the entries and writes nothing, so the caller decides whether the
 * promotion is human-reviewed or lands with the low confidence and short clock this
 * function gives it. `writeLore` is where the provenance refusals live, which is why
 * evidence falls back to the fact's own text rather than being left empty.
 */
export function promoteObservations(state: MissionState, now: Date): LoreEntry[] {
  const observedAt = now.toISOString();

  return state.mission.ledger.factsVerified
    // No self-reinforcement: a fact memory supplied must not be written back as a
    // fresh observation, or its staling clock resets every time it is read.
    .filter((fact) => fact.source.kind !== "memory")
    .map((fact) => ({
      id: `${state.mission.id}-${fact.id}`,
      claim: fact.text,
      type: "observation" as const,
      confidence: "low" as const,
      source: {
        missionId: state.mission.id,
        evidence: fact.source.ref.trim() === "" ? fact.text : fact.source.ref,
        kind: fact.source.kind,
      },
      observedAt,
      staleAfterDays: PROMOTED_STALE_AFTER_DAYS,
    }));
}
