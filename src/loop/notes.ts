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

/** Undelivered global notes — input to the loop's own next decision. */
export function pendingNotes(notes: readonly Note[]): Note[] {
  return notes.filter((note) => !note.deliveredAt && note.scope === "global");
}

/** A note becomes a fact the human gave. Ids continue from what is there, since
 *  `motivatedBy` names entries by id and a reused id points at the wrong thing. */
export function noteAsFact(note: Note, existing: readonly LedgerEntry[], round: number): LedgerEntry {
  return { id: `h${existing.length + 1}`, text: note.text, addedRound: round };
}
