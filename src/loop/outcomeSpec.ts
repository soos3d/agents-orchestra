// The single most important validation in the system (§4).
//
// A criterion the runtime cannot evaluate means the progress ledger can never
// legitimately set `isRequestSatisfied`, so the mission runs to its reset cap having
// done everything right. Every internal check reports success; nothing reports the
// contract was unverifiable.
//
// "Vague" is not a property code can read off a sentence. What it can read is whether
// the criterion carries a check that will ever produce an answer, and that is the
// operational definition used here: no check, a malformed one, or `kind: 'none'`.
import { criterionSchema, type Criterion } from "../domain/ledger.js";

export interface SpecRejection {
  /** The criterion as proposed, quoted so the retry knows which one to fix. */
  criterion: string;
  reason: string;
}

export type SpecResult =
  | { ok: true; criteria: Criterion[] }
  | { ok: false; rejected: SpecRejection[] };

/** Proposals arrive from a model, so the input is whatever it returned. */
export function writeOutcomeSpec(proposed: readonly unknown[]): SpecResult {
  if (proposed.length === 0) {
    return {
      ok: false,
      rejected: [
        {
          criterion: "(empty)",
          reason:
            "An outcome spec with no criteria has nothing to verify, so the mission could " +
            "never finish. State at least one criterion with a check.",
        },
      ],
    };
  }

  const criteria: Criterion[] = [];
  const rejected: SpecRejection[] = [];
  const seen = new Set<string>();

  for (const candidate of proposed) {
    const parsed = criterionSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      rejected.push({
        criterion: describe(candidate),
        reason:
          `${issue?.path.join(".") || "(root)"} ${issue?.message}. Every criterion needs an id, ` +
          `a statement, and a check that says how we will know.`,
      });
      continue;
    }

    const criterion = parsed.data;
    if (criterion.check.kind === "none") {
      rejected.push({
        criterion: criterion.statement,
        reason:
          `Its check is 'none', so it can never be evaluated and the mission could never ` +
          `legitimately report success. Give it a command to run or a rubric to judge.`,
      });
      continue;
    }

    if (seen.has(criterion.id)) {
      rejected.push({
        criterion: criterion.statement,
        reason: `Criterion id '${criterion.id}' is used twice. Give each one a distinct id.`,
      });
      continue;
    }

    seen.add(criterion.id);
    criteria.push(criterion);
  }

  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, criteria };
}

function describe(candidate: unknown): string {
  if (candidate && typeof candidate === "object" && "statement" in candidate) {
    return String((candidate as { statement: unknown }).statement);
  }
  return JSON.stringify(candidate) ?? String(candidate);
}
