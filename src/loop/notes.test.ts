// The failure this file exists to catch: a human's correction being forgotten by the
// replan that most needed it.
//
// A note delivered only to the current round changes one decision and then vanishes.
// The moment it matters is the reset — the replan is the thing about to walk back
// into the wall the note was warning about — so a note has to reach both the round
// and the ledger, and `factsGiven` is the one tier a replan may not drop (§3).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Note } from "../events/fold.js";
import { emptyLedger } from "../domain/ledger.js";
import { aMission, aMissionState } from "../testing/fixtures.js";
import { noteAsFact, pendingNotes } from "./notes.js";
import { buildProgressInput } from "./prompts.js";
import { reviseLedger } from "./revise.js";

const aNote = (patch: Partial<Note> = {}): Note => ({
  scope: "global",
  text: "stop using the staging database",
  at: "2026-07-25T10:00:00.000Z",
  ...patch,
});

describe("pendingNotes", () => {
  test("skips what has already been delivered, so a note lands once", () => {
    const notes = [aNote(), aNote({ text: "second", deliveredAt: "2026-07-25T10:01:00.000Z" })];

    assert.deepEqual(
      pendingNotes(notes).map((note) => note.text),
      ["stop using the staging database"],
    );
  });

  // A task note is for that worker. Leaking it into the progress call would put one
  // task's instruction in front of a decision about the whole mission.
  test("keeps task notes out of the loop's own decisions", () => {
    const notes = [aNote({ scope: "task", taskId: "t1", text: "for t1" }), aNote({ text: "global" })];

    assert.deepEqual(pendingNotes(notes).map((n) => n.text), ["global"]);
  });
});

describe("a note in the progress call", () => {
  test("reaches the decision it is meant to change", () => {
    const input = buildProgressInput(aMissionState({ notes: [aNote()] }));

    assert.deepEqual(input.notes, ["stop using the staging database"]);
  });

  test("is absent, not empty, when nobody said anything", () => {
    assert.equal(buildProgressInput(aMissionState()).notes, undefined);
  });

  test("a delivered note does not reach a second round", () => {
    const notes = [aNote({ deliveredAt: "2026-07-25T10:01:00.000Z" })];

    assert.equal(buildProgressInput(aMissionState({ notes })).notes, undefined);
  });
});

describe("a note in the ledger", () => {
  test("becomes a fact the human gave, with an id that does not collide", () => {
    const existing = [{ id: "h1", text: "already given", addedRound: 0 }];

    assert.deepEqual(noteAsFact(aNote(), existing, 4), {
      id: "h2",
      text: "stop using the staging database",
      addedRound: 4,
    });
  });

  // The whole reason a note goes to the ledger at all: the replan is what it needs to
  // survive. `factsGiven` is append-only (§3), and a planner that drops one is
  // corrected rather than believed.
  test("survives a replan that tries to drop it", () => {
    const mission = aMission({
      ledger: { ...emptyLedger(), factsGiven: [{ id: "h1", text: "use npm test", addedRound: 1 }] },
    });

    const result = reviseLedger(mission, { ...emptyLedger(), factsGiven: [] }, "a replan");

    assert.equal(result.kind, "revised");
    assert.ok(result.kind === "revised" && result.restored.length > 0);
    assert.deepEqual(
      result.kind === "revised" ? result.ledger.factsGiven.map((entry) => entry.text) : [],
      ["use npm test"],
    );
  });
});
