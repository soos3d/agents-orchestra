// The failure mode under test: a mission that learned something and told nobody.
//
// Promotion is the one direction of §6 with no natural caller — the mission is over,
// the exit code is already decided, and nothing downstream reads what gets written
// until the *next* mission runs. So these assert the audit trail exists (a file a
// human can find and delete, and an event naming it), that a rediscovered fact does
// not accumulate a second copy, and that a store that refuses a write cannot take a
// finished mission down with it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { emptyLedger, type Fact } from "../domain/ledger.js";
import { type EventInput } from "../events/schema.js";
import { aMission, aMissionState } from "../testing/fixtures.js";
import { readLore } from "./lore.js";
import { recordLearnings } from "./writeBack.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-writeback-"));
let dir: string;
let caseNo = 0;

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`, "lore");
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const now = new Date("2026-08-09T12:00:00.000Z");

const aFact = (patch: Partial<Fact> = {}): Fact => ({
  id: "f1",
  text: "routes live in src/routes",
  addedRound: 0,
  source: { kind: "research", ref: "src/routes/index.ts" },
  observedAt: "2026-08-09T10:00:00.000Z",
  ...patch,
});

const stateWith = (facts: Fact[]) =>
  aMissionState({ mission: aMission({ ledger: { ...emptyLedger(), factsVerified: facts } }) });

function harness(facts: Fact[]) {
  const events: EventInput[] = [];
  return {
    events,
    run: () =>
      recordLearnings({
        state: stateWith(facts),
        dir,
        now,
        emit: (event) => events.push(event),
      }),
  };
}

describe("recordLearnings", () => {
  test("writes a verified fact as lore and names the file on the log", () => {
    const h = harness([aFact()]);

    assert.equal(h.run(), 1);

    const written = h.events.filter((event) => event.type === "memory_written");
    assert.equal(written.length, 1);
    assert.ok(fs.existsSync(path.join(dir, path.basename((written[0] as { path: string }).path))));
  });

  // §6's first rule: a fact with no source is a rumour. The mission that observed it
  // and the evidence both have to survive the trip.
  test("what it writes carries its provenance", () => {
    harness([aFact()]).run();

    const { fresh } = readLore(dir, now);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]?.claim, "routes live in src/routes");
    assert.equal(fresh[0]?.source.missionId, "m1");
    assert.equal(fresh[0]?.source.evidence, "src/routes/index.ts");
    // No automatic learning (§6): what a mission promotes about itself lands weak and
    // on a short clock, so anything that survives does so by being re-observed.
    assert.equal(fresh[0]?.confidence, "low");
    assert.equal(fresh[0]?.type, "observation");
  });

  test("a fact recalled from memory is not written back", () => {
    const h = harness([aFact({ id: "m1", source: { kind: "memory", ref: "lore-1" } })]);

    assert.equal(h.run(), 0);
    assert.equal(h.events.length, 0);
  });

  // Rediscovery is the common case across missions, and a store that files one copy
  // per rediscovery is a store whose staling clock resets every time it is consulted.
  test("rediscovering the same fact adds nothing and says nothing", () => {
    harness([aFact()]).run();
    const second = harness([aFact({ id: "f2", source: { kind: "research", ref: "elsewhere.ts" } })]);

    assert.equal(second.run(), 0);
    assert.equal(second.events.length, 0);
    assert.equal(readLore(dir, now).fresh.length, 1);
  });

  test("a mission with nothing verified writes nothing, not an empty directory", () => {
    const h = harness([]);

    assert.equal(h.run(), 0);
    assert.equal(fs.existsSync(dir), false);
  });

  // The mission is already over and its exit code already decided. A cache that
  // refuses a write must be reported, not allowed to fail a completed mission.
  test("a refused write is warned about rather than thrown at the caller", () => {
    const warnings: string[] = [];
    const written = recordLearnings({
      state: stateWith([aFact({ text: "" })]),
      dir,
      now,
      emit: () => {},
      onWarn: (message) => warnings.push(message),
    });

    assert.equal(written, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /lore/i);
  });
});
