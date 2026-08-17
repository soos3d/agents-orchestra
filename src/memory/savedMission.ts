// Procedural memory, one level above a saved agent profile (§6, §7).
//
// Invoice reconciliation is monthly and a dependency audit is weekly. Re-briefing
// from scratch each time discards the sign-off that was already given, the envelope
// that was already scoped, and the guesses that were already corrected — so a saved
// mission carries the goal, the envelope, the criteria as a *skeleton*, and last
// time's intake answers.
//
// What it deliberately does not carry is the outcome. `met`, `evidence`, and
// `lastCheckedRound` are stripped here rather than filtered later, because the
// environment moved since March even if the job did not: a replay re-runs scan and
// research every time, and a criteria skeleton is something to converge on rather
// than a result to reuse. A saved `met: true` would be a mission that reports success
// before it starts.
//
// The file is markdown for the same reason lore is (§6): a human has to be able to
// read what will be replayed and edit it. The prose is what they read; the one fenced
// JSON block is what this file parses, because an envelope round-tripped through
// prose is an envelope that eventually widens by a typo — and the envelope is the
// security boundary (§4.0).
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensurePrivateDir, writeFileAtomic } from "../config/hygiene.js";
import { verifySpecSchema } from "../domain/artifacts.js";
import { envelopeSchema } from "../domain/envelope.js";
import { type Criterion, type LedgerEntry, type TaskLedger } from "../domain/ledger.js";
import { type MissionState } from "../events/fold.js";
import { assertPlainName, parseFencedPayload } from "./fencedPayload.js";

export const savedMissionSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  envelope: envelopeSchema,
  // Statement and check only. Everything a run *concluded* is absent by construction
  // rather than by a filter somebody has to remember to apply.
  criteriaSkeleton: z.array(z.object({ statement: z.string().min(1), check: verifySpecSchema })),
  intakeAnswers: z.array(z.object({ question: z.string().min(1), answer: z.string() })),
  savedAt: z.string().min(1),
  fromMissionId: z.string().min(1),
});

export type SavedMission = z.infer<typeof savedMissionSchema>;

/** Saved missions are cross-mission, like lore, so they sit beside `missions/` rather
 *  than inside one — `orchestra forget` must not take next month's job with it. */
export const savedDir = (stateDir: string): string => path.join(stateDir, "saved");

const FIX = "Re-create it with 'orchestra save <missionId> --as <name>', or fix the ```json block by hand.";

const FENCE = "```json";

/** Prose for the human, one fenced block for the machine. */
export function renderSavedMission(saved: SavedMission): string {
  const answers =
    saved.intakeAnswers.length === 0
      ? ["_none asked_"]
      : saved.intakeAnswers.map((entry) => `- **${entry.question}** ${entry.answer}`);
  const criteria =
    saved.criteriaSkeleton.length === 0
      ? ["_none_"]
      : saved.criteriaSkeleton.map(
          (criterion, index) => `${index + 1}. ${criterion.statement} — check: ${criterion.check.kind}`,
        );

  return [
    `# ${saved.name}`,
    "",
    `Saved from mission \`${saved.fromMissionId}\` at ${saved.savedAt}.`,
    "A replay re-runs scan and research; nothing below is an outcome.",
    "",
    "## Goal",
    "",
    saved.goal,
    "",
    "## Criteria skeleton",
    "",
    ...criteria,
    "",
    "## Intake answers from last time",
    "",
    ...answers,
    "",
    "## Payload",
    "",
    "Edited by hand at your own risk — this block is what is actually replayed.",
    "",
    FENCE,
    JSON.stringify(saved, null, 2),
    "```",
    "",
  ].join("\n");
}

export type ParseSavedMissionResult =
  | { ok: true; saved: SavedMission }
  | { ok: false; problem: string };

export function parseSavedMission(markdown: string): ParseSavedMissionResult {
  const parsed = parseFencedPayload(markdown, savedMissionSchema, FIX);
  return parsed.ok ? { ok: true, saved: parsed.value } : parsed;
}

/**
 * What a finished mission is worth keeping.
 *
 * The intake answers are recovered by pairing the questions the log asked with the
 * `factsGiven` they became (`loop/intake.ts` writes "<question> — <answer>"). The
 * answer text itself is not folded into state — `intake_answered` resolves the inbox
 * item and nothing else — and reading the log again here would give this function a
 * second source of truth for something the ledger already holds.
 */
export function saveMission(
  stateDir: string,
  name: string,
  state: MissionState,
  savedAt: string,
): string {
  assertPlainName(name, "saved-mission name", "monthly-reconcile");

  const { mission } = state;
  if (!mission.signedOffAt) {
    throw new Error(
      `Refusing to save mission '${mission.id}': it never reached sign-off, so no human ever ` +
        `approved its criteria. '--unattended --saved' rests on exactly that approval (§7). ` +
        `Sign the mission off first, or save a different one.`,
    );
  }

  const saved: SavedMission = {
    name,
    goal: mission.goal,
    envelope: mission.capabilityEnvelope,
    criteriaSkeleton: mission.ledger.criteria.map((criterion) => ({
      statement: criterion.statement,
      check: criterion.check,
    })),
    intakeAnswers: intakeAnswersOf(state),
    savedAt,
    fromMissionId: mission.id,
  };

  const dir = ensurePrivateDir(savedDir(stateDir));
  const file = path.join(dir, `${name}.md`);
  writeFileAtomic(file, renderSavedMission(saved));
  return file;
}

const SEPARATOR = " — ";

function intakeAnswersOf(state: MissionState): SavedMission["intakeAnswers"] {
  const stated = state.mission.ledger.factsGiven;

  return state.inbox
    .filter((item) => item.kind === "intake")
    .flatMap((item) => {
      const prefix = `${item.summary}${SEPARATOR}`;
      const fact = stated.find((entry) => entry.text.startsWith(prefix));
      // A question nobody answered became a labelled guess at sign-off (§2b), not an
      // answer, so there is nothing here worth replaying.
      if (!fact) return [];
      return [{ question: item.summary, answer: fact.text.slice(prefix.length) }];
    });
}

export function loadSavedMission(stateDir: string, name: string): SavedMission {
  assertPlainName(name, "saved-mission name", "monthly-reconcile");

  const file = path.join(savedDir(stateDir), `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No saved mission '${name}' under ${savedDir(stateDir)}. ` +
        `Create one with 'orchestra save <missionId> --as ${name}'.`,
    );
  }

  const parsed = parseSavedMission(fs.readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Error(`Cannot read ${file}: ${parsed.problem}`);
  return parsed.saved;
}

/**
 * A saved mission entering a fresh ledger, before anything is paid for.
 *
 * The answers land in `factsGiven` — the tier a replan may never drop (§3) — which is
 * also the list intake reads as `known`, so the same question is not asked twice. The
 * criteria land as ordinary mutable ledger state, which is legal precisely because
 * sign-off has not happened yet (§3): research overwrites them with what it finds,
 * and the skeleton is only ever a starting point to converge on.
 */
export function seedFromSaved(ledger: TaskLedger, saved: SavedMission): TaskLedger {
  const taken = new Set(ledger.factsGiven.map((entry) => entry.id));
  let next = 1;

  const given: LedgerEntry[] = saved.intakeAnswers.map((answer) => {
    while (taken.has(`h${next}`)) next++;
    const id = `h${next}`;
    taken.add(id);
    return { id, text: `${answer.question}${SEPARATOR}${answer.answer}`, addedRound: 0 };
  });

  const criteria: Criterion[] = saved.criteriaSkeleton.map((criterion, index) => ({
    id: `c${index + 1}`,
    statement: criterion.statement,
    check: criterion.check,
  }));

  return {
    ...ledger,
    factsGiven: [...ledger.factsGiven, ...given],
    criteria,
  };
}
