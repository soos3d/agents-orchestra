// The two directions between semantic memory and the task ledger, and the rule that
// makes both safe (§6).
//
// Inbound: a stale fact enters the ledger as a *guess*, never as a verified fact.
// That single distinction is what stops a fact that was true in March from being
// treated as ground truth by every plan in August, and it is the milestone this file
// exists to assert.
//
// Outbound: promotion never re-promotes what memory itself supplied. Without that,
// a fact recalled from lore is written back as a fresh observation on every mission,
// its clock resets, and the store convinces itself of something nobody re-verified —
// which is §6's "no automatic learning" rule failing quietly rather than loudly.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { emptyLedger, type Fact } from "../domain/ledger.js";
import { aMission, aMissionState } from "../testing/fixtures.js";
import { promoteObservations, recallToLedger } from "./recall.js";
import { isStale, writeLore, type LoreEntry } from "./lore.js";

const AT = "2026-08-09T12:00:00.000Z";

function lore(overrides: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: "l1",
    claim: "The API client lives in src/net/.",
    type: "observation",
    confidence: "high",
    source: { missionId: "m-42", evidence: "src/net/client.ts", kind: "codebase" },
    observedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function verifiedFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f1",
    text: "Ramp exports as CSV, not via the API",
    addedRound: 1,
    source: { kind: "research", ref: "https://ramp.com/docs/export" },
    observedAt: "2026-08-09T09:00:00.000Z",
    ...overrides,
  };
}

describe("recallToLedger", () => {
  test("a fresh entry becomes a memory-sourced Fact", () => {
    const { facts, guesses } = recallToLedger([lore()], [], AT);

    assert.deepEqual(guesses, []);
    assert.deepEqual(facts, [
      {
        id: "m1",
        text: "The API client lives in src/net/.",
        addedRound: 0,
        source: { kind: "memory", ref: "l1" },
        observedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  test("a stale entry becomes a low-confidence Guess, never a Fact", () => {
    const stale = lore({ id: "l9", claim: "Stripe retries webhooks for 3 days", type: "research" });

    const { facts, guesses } = recallToLedger([], [stale], AT);

    assert.deepEqual(facts, []);
    assert.equal(guesses.length, 1);
    assert.equal(guesses[0]?.text, "Stripe retries webhooks for 3 days");
    assert.equal(guesses[0]?.confidence, "low");
    assert.match(guesses[0]?.basis ?? "", /stale/i);
    assert.match(guesses[0]?.basis ?? "", /l9/);
  });

  test("the guess basis names when the claim was observed and when it was recalled", () => {
    const { guesses } = recallToLedger([], [lore({ observedAt: "2026-01-02T00:00:00.000Z" })], AT);

    assert.match(guesses[0]?.basis ?? "", /2026-01-02/);
    assert.match(guesses[0]?.basis ?? "", /2026-08-09/);
  });

  test("fact and guess ids never collide, however many of each there are", () => {
    const { facts, guesses } = recallToLedger(
      [lore({ id: "a", claim: "one" }), lore({ id: "b", claim: "two" })],
      [lore({ id: "c", claim: "three" }), lore({ id: "d", claim: "four" })],
      AT,
    );

    const ids = [...facts.map((f) => f.id), ...guesses.map((g) => g.id)];
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(", ")}`);
  });

  test("numbering continues from what the caller already allocated", () => {
    const { facts, guesses } = recallToLedger([lore({ claim: "one" })], [lore({ claim: "two" })], AT, {
      startIndex: 4,
      addedRound: 3,
    });

    assert.equal(facts[0]?.id, "m5");
    assert.equal(guesses[0]?.id, "mg5");
    assert.equal(facts[0]?.addedRound, 3);
    assert.equal(guesses[0]?.addedRound, 3);
  });

  test("empty memory produces empty ledger entries rather than throwing", () => {
    assert.deepEqual(recallToLedger([], [], AT), { facts: [], guesses: [] });
  });
});

describe("promoteObservations", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  const stateWith = (factsVerified: Fact[]) =>
    aMissionState({
      mission: { ...aMission({ id: "m-77" }), ledger: { ...emptyLedger(), factsVerified } },
    });

  test("a verified fact becomes a low-confidence observation on a short clock", () => {
    const [promoted, ...rest] = promoteObservations(stateWith([verifiedFact()]), now);

    assert.deepEqual(rest, []);
    assert.equal(promoted?.claim, "Ramp exports as CSV, not via the API");
    assert.equal(promoted?.type, "observation");
    assert.equal(promoted?.confidence, "low");
    assert.equal(promoted?.staleAfterDays, 7);
    assert.equal(promoted?.observedAt, "2026-08-09T12:00:00.000Z");
  });

  test("provenance comes from the mission and the fact's own source", () => {
    const [promoted] = promoteObservations(stateWith([verifiedFact()]), now);

    assert.deepEqual(promoted?.source, {
      missionId: "m-77",
      evidence: "https://ramp.com/docs/export",
      kind: "research",
    });
  });

  test("a fact whose source ref is blank still carries evidence, so the write is not refused", () => {
    const [promoted] = promoteObservations(
      stateWith([verifiedFact({ source: { kind: "worker", ref: "" } })]),
      now,
    );

    assert.notEqual(promoted?.source.evidence.trim(), "");
  });

  test("a fact that came from memory is not promoted back into memory", () => {
    const fromMemory = verifiedFact({ id: "f2", source: { kind: "memory", ref: "l1" } });

    const promoted = promoteObservations(stateWith([verifiedFact(), fromMemory]), now);

    assert.deepEqual(
      promoted.map((entry) => entry.claim),
      ["Ramp exports as CSV, not via the API"],
    );
  });

  test("ids are unique per fact so two promotions never overwrite each other", () => {
    const promoted = promoteObservations(
      stateWith([verifiedFact({ id: "f1", text: "one" }), verifiedFact({ id: "f2", text: "two" })]),
      now,
    );

    assert.equal(new Set(promoted.map((entry) => entry.id)).size, 2);
  });

  test("a mission with no verified facts promotes nothing", () => {
    assert.deepEqual(promoteObservations(stateWith([]), now), []);
  });

  // The composition, not the mechanism. Each half passes its own tests while a
  // promoted entry is refused at the write boundary — an entry with no evidence, or
  // typed `principle` — and nothing would say so.
  test("what promotion produces is accepted by writeLore as the orchestrator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-promote-"));
    const facts = [verifiedFact(), verifiedFact({ id: "f2", text: "second", source: { kind: "worker", ref: "" } })];

    const results = promoteObservations(stateWith(facts), now).map((entry) =>
      writeLore(dir, entry, "orchestrator"),
    );

    assert.deepEqual(
      results.map((result) => result.written),
      [true, true],
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a promoted observation recalls as a fact while fresh and a guess once stale", () => {
    const [promoted] = promoteObservations(stateWith([verifiedFact()]), now);
    assert.ok(promoted);
    const sixDaysOn = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
    const eightDaysOn = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);

    assert.equal(isStale(promoted, sixDaysOn), false);
    assert.equal(isStale(promoted, eightDaysOn), true);
    assert.equal(recallToLedger([promoted], [], AT).facts.length, 1);
    assert.equal(recallToLedger([], [promoted], AT).guesses[0]?.confidence, "low");
  });
});
