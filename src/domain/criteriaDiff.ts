// Applying a criteria change that a human approved (§3), and nothing else.
//
// Criteria are frozen from the moment of sign-off: `revise.ts` refuses a replan that
// touches one, and `fold`'s `assertLedgerRules` refuses a log that did. That leaves
// exactly one door, and this is the hinge on it — `criteria_change_resolved` with
// `approved: true` is the only event in the system that may move the contract, and
// this is the only function that moves it.
//
// So it is deliberately unforgiving. A diff naming a criterion the ledger does not
// hold was written against a ledger that has since moved, and applying the rest of it
// quietly would record an approved change as landed while the approved part went
// nowhere. That is the failure this whole section exists to prevent, one level down,
// so it raises with the offending id named.
import { type Criterion, type CriterionDiff } from "./ledger.js";

export class CriteriaDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriteriaDiffError";
  }
}

export function applyCriteriaDiff(
  criteria: readonly Criterion[],
  diff: readonly CriterionDiff[],
): Criterion[] {
  let applied = [...criteria];

  for (const op of diff) {
    if (op.op === "add") {
      if (applied.some((criterion) => criterion.id === op.criterion.id)) {
        throw new CriteriaDiffError(
          `The approved change adds criterion '${op.criterion.id}', which already exists. ` +
            `Reject the change and let the replan restate it as an amend.`,
        );
      }
      applied = [...applied, op.criterion];
      continue;
    }

    const index = applied.findIndex((criterion) => criterion.id === op.criterionId);
    if (index === -1) {
      throw new CriteriaDiffError(
        `The approved change ${op.op}s criterion '${op.criterionId}', which the ledger no ` +
          `longer holds. Reject the change and let the replan propose one against the ` +
          `current spec.`,
      );
    }

    if (op.op === "remove") {
      applied = applied.filter((_, i) => i !== index);
      continue;
    }

    // `met`, `evidence`, and `lastCheckedRound` are check *results* and never part of
    // the contract (`revise.ts` says the same thing from the other side). Carrying one
    // across an amend would leave a verdict standing against a statement that has
    // changed under it, which is a criterion reporting `met` for work nobody checked.
    const { met: _met, evidence: _evidence, lastCheckedRound: _round, ...contract } = op.to;
    applied = applied.map((criterion, i) => (i === index ? contract : criterion));
  }

  return applied;
}
