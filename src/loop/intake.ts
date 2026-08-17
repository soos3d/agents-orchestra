// Up to three questions, asked after the scan and before anything is paid for (§2b).
//
// The cap is here rather than in the prompt because a model told to ask at most three
// will eventually ask four, and the failure is not loud: a system that interviews you
// for ten minutes has moved the work back onto the human, which is the thing this
// project exists to avoid. `INTAKE_PROMPT` asks for restraint and this enforces it.
//
// Dropping the extras rather than rejecting the answer is deliberate. Rejecting would
// spend a reformat call to arrive at the same three questions, and the fourth question
// is not wasted either way — §2b's rule is that anything below the cap becomes a
// labelled guess on the sign-off screen, which is the second and cheaper place to
// catch it.
//
// Duplicate ids are dropped for a different reason. `intake_question` opens an inbox
// item keyed by `questionId` and `intake_answered` resolves the item with that id, so
// two questions sharing one id leave an item that can never be resolved — a mission
// that parks forever waiting on an answer somebody already gave.
import { type LedgerEntry } from "../domain/ledger.js";
import { type EventInput } from "../events/schema.js";
import { type Calls, type IntakeQuestion } from "./calls.js";
import { type HumanPort, type IntakeAnswer } from "./human.js";
import { type MissionStore } from "./run.js";

/** §2b, in code. Three is a judgment about attention, not about model capability. */
export const MAX_INTAKE_QUESTIONS = 3;

export interface CappedQuestions {
  asked: IntakeQuestion[];
  /** Kept rather than discarded so the caller can say what it did not ask. */
  dropped: IntakeQuestion[];
}

export function capQuestions(questions: readonly IntakeQuestion[]): CappedQuestions {
  const asked: IntakeQuestion[] = [];
  const dropped: IntakeQuestion[] = [];
  const seen = new Set<string>();

  for (const question of questions) {
    const duplicate = seen.has(question.id);
    if (!duplicate) seen.add(question.id);

    if (duplicate || asked.length >= MAX_INTAKE_QUESTIONS) {
      dropped.push(question);
      continue;
    }
    asked.push(question);
  }

  return { asked, dropped };
}

/**
 * An answered question becomes a `factGiven` — stated by the human, taken as true.
 *
 * That tier is append-only across replans (§3), which is what makes an intake answer
 * survive a mission that resets three times. Recording it as a verified fact instead
 * would put it behind §6's provenance rules and let a later revision drop it, and the
 * human's own words are the last thing a replan should be able to forget.
 *
 * The question is carried alongside the answer because "calendar" means nothing six
 * rounds later without "does June mean calendar or fiscal?" in front of it.
 */
export function answersAsFacts(
  questions: readonly IntakeQuestion[],
  answers: readonly IntakeAnswer[],
  existing: readonly LedgerEntry[],
): LedgerEntry[] {
  let next = existing.length;

  return answers.flatMap((answer) => {
    const question = questions.find((candidate) => candidate.id === answer.questionId);
    if (!question || answer.answer.trim() === "") return [];

    next += 1;
    return [
      {
        id: `h${next}`,
        text: `${question.question} — ${answer.answer.trim()}`,
        // Intake happens before the first round, so a fact it produces is round 0's.
        addedRound: 0,
      },
    ];
  });
}

export interface IntakeDeps {
  store: MissionStore;
  calls: Pick<Calls, "intake">;
  human: HumanPort;
  onWarn?(message: string): void;
}

/**
 * Runs intake and returns the ledger the answers produced.
 *
 * Returns rather than writes, so the caller decides when the ledger changes — one
 * `ledger_revised` at a known point beats two half-applied ones if the process dies
 * between them.
 */
export async function runIntake(deps: IntakeDeps): Promise<LedgerEntry[]> {
  const state = deps.store.state();
  const { mission } = state;
  const base = { missionId: mission.id, actor: "orchestrator" as const };
  const emit = (event: EventInput) => deps.store.emit(event);

  const result = await deps.calls.intake({
    goal: mission.goal,
    findings: mission.ledger.factsVerified.map((fact) => ({
      claim: fact.text,
      source: fact.source.ref,
      sourceKind: fact.source.kind === "memory" ? "memory" : "codebase",
      confidence: "high",
    })),
    known: mission.ledger.factsGiven.map((entry) => entry.text),
    envelope: mission.capabilityEnvelope,
  });

  const { asked, dropped } = capQuestions(result.questions);
  if (dropped.length > 0) {
    deps.onWarn?.(
      `Intake proposed ${result.questions.length} questions; asking ${asked.length}. ` +
        `The rest become guesses you review at sign-off: ` +
        `${dropped.map((question) => question.question).join(" / ")}`,
    );
  }

  if (asked.length === 0) return [];

  for (const question of asked) {
    emit({
      ...base,
      type: "intake_question",
      questionId: question.id,
      question: question.question,
      ...(question.options ? { options: question.options } : {}),
    });
  }

  const answers = await deps.human.askIntake(asked);

  // Every question asked gets closed, including the ones nobody answered.
  //
  // Driven from `asked` rather than from `answers` for two reasons, and both are the
  // same bug from opposite ends: a port returning an id nobody asked about would
  // resolve nothing, and a skipped question would resolve nothing either. Both leave
  // an inbox item open, and an open item parks the mission — `continuationFor` halts
  // on one, so a question the human chose not to answer would strand the run. §2b
  // already says what an unanswered question is worth: it becomes a labelled guess at
  // sign-off, not a blocker.
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.answer]));
  const closed = asked.map((question) => ({
    questionId: question.id,
    answer: byId.get(question.id) ?? "",
  }));

  for (const answer of closed) {
    emit({ ...base, type: "intake_answered", questionId: answer.questionId, answer: answer.answer });
  }

  return answersAsFacts(asked, closed, mission.ledger.factsGiven);
}
