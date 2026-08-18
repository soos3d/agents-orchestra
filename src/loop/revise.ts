// The ledger mutability rules, enforced where the revision is written (§3).
//
// The ledger is revised on every replan and `criteria` live in it. Left alone, the
// system can run three unattended replans, rewrite the outcome spec a human
// approved, and then *legitimately* report success against goalposts it moved
// itself — every internal check agreeing the whole way.
//
// So a proposal that touches a frozen criterion is not applied. It becomes a request
// that returns the mission to sign-off. `fold` asserts the same rule on replay; this
// is the write-time half, and the two exist for different reasons: this one stops it
// happening, that one stops a log that did it from being trusted.
import { type CriterionDiff, type Criterion, type TaskLedger } from "../domain/ledger.js";
import { type Mission } from "../domain/mission.js";

export type LedgerRevision =
  | {
      kind: "revised";
      ledger: TaskLedger;
      /** Append-only entries the proposal dropped and this put back. Non-empty means
       *  the planner tried to forget something; the caller should say so out loud. */
      restored: string[];
    }
  | { kind: "criteria_change"; diff: CriterionDiff[]; reasoning: string };

/**
 * Apply a proposed ledger under the §3 rules: `criteria` frozen from sign-off,
 * `deadEnds` and `factsGiven` append-only, everything else freely revised.
 */
export function reviseLedger(
  mission: Mission,
  proposed: TaskLedger,
  reasoning: string,
): LedgerRevision {
  const current = mission.ledger;

  if (mission.signedOffAt) {
    const diff = criteriaDiff(current.criteria, proposed.criteria, reasoning);
    if (diff.length > 0) return { kind: "criteria_change", diff, reasoning };
  }

  const deadEnds = restore(current.deadEnds, proposed.deadEnds);
  const factsGiven = restore(current.factsGiven, proposed.factsGiven);

  return {
    kind: "revised",
    restored: [...deadEnds.restored, ...factsGiven.restored],
    ledger: {
      ...proposed,
      // Before sign-off criteria are ordinary mutable state; after it, the branch
      // above already returned, so keeping the current set here is not a second rule.
      criteria: mission.signedOffAt ? current.criteria : proposed.criteria,
      deadEnds: deadEnds.entries,
      factsGiven: factsGiven.entries,
    },
  };
}

/** A dropped dead end is how a replan re-proposes the approach that just failed. */
function restore<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): { entries: T[]; restored: string[] } {
  const kept = new Set(after.map((entry) => entry.id));
  const dropped = before.filter((entry) => !kept.has(entry.id));
  return { entries: [...dropped, ...after], restored: dropped.map((entry) => entry.id) };
}

/** `met`, `evidence`, and `lastCheckedRound` are check *results* and change freely.
 *  Only the contract — id, statement, check — is frozen. */
const contractOf = (criterion: Criterion): string =>
  JSON.stringify([criterion.statement, criterion.check]);

export function criteriaDiff(
  before: readonly Criterion[],
  after: readonly Criterion[],
  reason: string,
): CriterionDiff[] {
  const byIdBefore = new Map(before.map((criterion) => [criterion.id, criterion]));
  const byIdAfter = new Map(after.map((criterion) => [criterion.id, criterion]));

  const diff: CriterionDiff[] = [];

  for (const criterion of before) {
    const next = byIdAfter.get(criterion.id);
    if (!next) {
      diff.push({ op: "remove", criterionId: criterion.id, reason });
      continue;
    }
    if (contractOf(criterion) !== contractOf(next)) {
      diff.push({ op: "amend", criterionId: criterion.id, from: criterion, to: next, reason });
    }
  }

  for (const criterion of after) {
    if (!byIdBefore.has(criterion.id)) diff.push({ op: "add", criterion });
  }

  return diff;
}
