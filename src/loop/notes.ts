// Steering a running mission without stopping it (§10).
//
// The rule the whole human channel is built on: block early and cheaply, or not at
// all. Intake and sign-off block before any work is paid for; after that a note goes
// in at any moment and the loop never waits for one.
//
// A global note also enters the ledger as a `factGiven`, and that is the part worth
// being deliberate about. `factsGiven` is append-only across replans (§3), so a
// correction survives the reset. A note that only reached the current round would be
// forgotten by the next replan — which is precisely the moment the human's correction
// matters most, because the replan is the thing about to walk into the same wall
// again.
import { type Note } from "../events/fold.js";
import { type LedgerEntry } from "../domain/ledger.js";

/** Undelivered notes for one destination. Task notes go to that task and nowhere
 *  else; a global note is for the loop's own next decision. */
export function pendingNotes(
  notes: readonly Note[],
  scope: "global" | "task",
  taskId?: string,
): Note[] {
  return notes.filter(
    (note) => !note.deliveredAt && note.scope === scope && (scope === "global" || note.taskId === taskId),
  );
}

/**
 * The block appended to a worker's prompt, and to the progress call's input.
 *
 * Fenced with a heading rather than merged into the surrounding prose because the
 * recipient has to be able to tell a human's instruction from the orchestrator's:
 * a note saying "stop using the staging database" reads very differently as a line
 * of the task goal than as something a person said mid-run.
 */
export function formatNotes(notes: readonly Note[]): string | undefined {
  if (notes.length === 0) return undefined;
  return ["--- HUMAN NOTES ---", ...notes.map((note) => `- ${note.text}`)].join("\n");
}

/** A note becomes a fact the human gave. Ids continue from what is there, since
 *  `motivatedBy` names entries by id and a reused id points at the wrong thing. */
export function noteAsFact(note: Note, existing: readonly LedgerEntry[], round: number): LedgerEntry {
  return { id: `h${existing.length + 1}`, text: note.text, addedRound: round };
}
