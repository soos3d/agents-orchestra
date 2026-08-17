// The failure mode: a saved mission that carries the previous *outcome* forward.
//
// A replay re-runs scan and research every time (§7), so what is saved is the goal,
// the envelope a human scoped, the criteria as a skeleton, and last time's intake
// answers — never `met`, never evidence. The other failures asserted here are the two
// that make `--unattended --saved` a defensible trade rather than a shortcut: a name
// that is really a path, and a mission whose criteria nobody ever approved.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  loadSavedMission,
  parseSavedMission,
  renderSavedMission,
  saveMission,
  savedDir,
  seedFromSaved,
  type SavedMission,
} from "./savedMission.js";
import { emptyLedger } from "../domain/ledger.js";
import { aCriterion, aMission, aMissionState, anEnvelope } from "../testing/fixtures.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-saved-"));
let stateDir: string;
let caseNo = 0;

beforeEach(() => {
  stateDir = path.join(tmpRoot, `case-${++caseNo}`);
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const aSavedMission = (patch: Partial<SavedMission> = {}): SavedMission => ({
  name: "monthly-reconcile",
  goal: "Reconcile June invoices across Xero and Ramp",
  envelope: anEnvelope(),
  criteriaSkeleton: [
    { statement: "Every June invoice matched", check: { kind: "judge", rubric: "counts equal" } },
  ],
  intakeAnswers: [{ question: "Does June mean calendar month?", answer: "calendar" }],
  savedAt: "2026-08-09T10:00:00.000Z",
  fromMissionId: "m1",
  ...patch,
});

/** A mission that reached sign-off, with one intake question answered. */
function signedOffState(patch: { signedOffAt?: string } = {}) {
  return aMissionState({
    mission: aMission({
      goal: "Reconcile June invoices across Xero and Ramp",
      capabilityEnvelope: anEnvelope({ domains: ["xero.com"] }),
      signedOffAt: patch.signedOffAt ?? "2026-08-09T09:00:00.000Z",
      ledger: {
        ...emptyLedger(),
        factsGiven: [
          { id: "h1", text: "Does June mean calendar month? — calendar", addedRound: 0 },
        ],
        criteria: [
          aCriterion({
            id: "c1",
            statement: "Every June invoice matched",
            check: { kind: "judge", rubric: "counts equal" },
            met: true,
            lastCheckedRound: 4,
          }),
        ],
      },
    }),
    inbox: [
      {
        id: "q1",
        kind: "intake",
        summary: "Does June mean calendar month?",
        openedAt: "2026-08-09T08:00:00.000Z",
        resolvedAt: "2026-08-09T08:01:00.000Z",
      },
    ],
  });
}

describe("saved missions", () => {
  describe("rendering", () => {
    test("round trips through markdown", () => {
      const saved = aSavedMission();

      const parsed = parseSavedMission(renderSavedMission(saved));

      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.ok && parsed.saved, saved);
    });

    test("is readable prose as well as a machine payload", () => {
      const markdown = renderSavedMission(aSavedMission());

      assert.match(markdown, /# monthly-reconcile/);
      assert.match(markdown, /Reconcile June invoices/);
      assert.match(markdown, /Does June mean calendar month\?/);
    });

    test("a mangled payload block fails with the fix rather than a zod path", () => {
      const parsed = parseSavedMission("# broken\n\n```json\n{ not json\n```\n");

      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? "" : parsed.problem, /orchestra save/);
    });

    test("a file with no payload block at all says what is missing", () => {
      const parsed = parseSavedMission("# monthly-reconcile\n\njust prose\n");

      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? "" : parsed.problem, /json/);
    });
  });

  describe("saveMission", () => {
    test("writes goal, envelope, criteria skeleton, and intake answers", () => {
      const file = saveMission(stateDir, "monthly", signedOffState(), "2026-08-09T10:00:00.000Z");

      const parsed = parseSavedMission(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.ok, true);
      const saved = parsed.ok ? parsed.saved : aSavedMission();
      assert.equal(saved.goal, "Reconcile June invoices across Xero and Ramp");
      assert.deepEqual(saved.envelope.domains, ["xero.com"]);
      assert.deepEqual(saved.criteriaSkeleton, [
        { statement: "Every June invoice matched", check: { kind: "judge", rubric: "counts equal" } },
      ]);
      assert.deepEqual(saved.intakeAnswers, [
        { question: "Does June mean calendar month?", answer: "calendar" },
      ]);
    });

    // The whole point of the skeleton: a replay re-runs scan and research, and never
    // reuses the previous outcome (§7).
    test("carries no outcome forward — no met, no evidence", () => {
      const file = saveMission(stateDir, "monthly", signedOffState(), "2026-08-09T10:00:00.000Z");

      const raw = fs.readFileSync(file, "utf8");
      assert.equal(raw.includes('"met"'), false);
      assert.equal(raw.includes("lastCheckedRound"), false);
    });

    test("refuses a name that is really a path", () => {
      for (const name of ["../escape", "a/b", "a\\b", ""]) {
        assert.throws(
          () => saveMission(stateDir, name, signedOffState(), "2026-08-09T10:00:00.000Z"),
          /not a saved-mission name/,
        );
      }
    });

    // `--unattended --saved` rests entirely on criteria a human approved, so a
    // mission that never reached sign-off has nothing worth trusting.
    test("refuses a mission that never reached sign-off, and says why", () => {
      const unsigned = aMissionState({ mission: aMission({ signedOffAt: undefined }) });

      assert.throws(
        () => saveMission(stateDir, "monthly", unsigned, "2026-08-09T10:00:00.000Z"),
        /sign-off/,
      );
    });

    test("writes owner-only, atomically, under saved/", () => {
      const file = saveMission(stateDir, "monthly", signedOffState(), "2026-08-09T10:00:00.000Z");

      assert.equal(file, path.join(savedDir(stateDir), "monthly.md"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(savedDir(stateDir)).mode & 0o777, 0o700);
      assert.deepEqual(fs.readdirSync(savedDir(stateDir)), ["monthly.md"]);
    });
  });

  describe("loadSavedMission", () => {
    test("reads back what saveMission wrote", () => {
      saveMission(stateDir, "monthly", signedOffState(), "2026-08-09T10:00:00.000Z");

      assert.equal(loadSavedMission(stateDir, "monthly").name, "monthly");
    });

    test("a missing file names the directory and how to create one", () => {
      assert.throws(() => loadSavedMission(stateDir, "ghost"), (error: Error) => {
        assert.match(error.message, /saved/);
        assert.match(error.message, /orchestra save <missionId> --as ghost/);
        return true;
      });
    });

    test("a mangled file names the file rather than failing obscurely", () => {
      fs.mkdirSync(savedDir(stateDir), { recursive: true });
      fs.writeFileSync(path.join(savedDir(stateDir), "bent.md"), "# bent\n\nno payload\n");

      assert.throws(() => loadSavedMission(stateDir, "bent"), /bent\.md/);
    });

    test("refuses a name that is really a path", () => {
      assert.throws(() => loadSavedMission(stateDir, "../../etc/passwd"), /not a saved-mission name/);
    });
  });

  describe("seedFromSaved", () => {
    test("seeds intake answers as factsGiven and criteria as a skeleton", () => {
      const seeded = seedFromSaved(emptyLedger(), aSavedMission());

      assert.deepEqual(
        seeded.factsGiven.map((entry) => entry.text),
        ["Does June mean calendar month? — calendar"],
      );
      assert.equal(seeded.criteria.length, 1);
      assert.equal(seeded.criteria[0]!.statement, "Every June invoice matched");
      assert.equal(seeded.criteria[0]!.met, undefined);
    });

    test("appends rather than replacing what the ledger already holds", () => {
      const ledger = {
        ...emptyLedger(),
        factsGiven: [{ id: "h1", text: "already stated", addedRound: 0 }],
      };

      const seeded = seedFromSaved(ledger, aSavedMission());

      assert.equal(seeded.factsGiven.length, 2);
      assert.equal(seeded.factsGiven[0]!.text, "already stated");
      // Ids stay unique, or `motivatedBy` points at the wrong entry (§4.2).
      assert.equal(new Set(seeded.factsGiven.map((entry) => entry.id)).size, 2);
    });
  });

  // The failure mode: `--staff` is typed once at the terminal and then has to be
  // remembered forever, because the preset that carries everything else about the mission
  // drops the one field that decides which model answers which decision point. The other
  // half is the field being new: a preset written before it existed must still load, or
  // adding it breaks every saved mission on disk.
  describe("staffing", () => {
    const staffed = { research: "moonshotai/Kimi-K3", critique: "deepseek-ai/DeepSeek-V4-Pro" };

    test("survives the save/load round trip", () => {
      const state = signedOffState();
      const file = saveMission(
        stateDir,
        "kimi-deepseek",
        { ...state, mission: { ...state.mission, staffing: staffed } },
        "2026-08-17T10:00:00.000Z",
      );

      assert.deepEqual(loadSavedMission(stateDir, "kimi-deepseek").staffing, staffed);
      // And in the prose, not only in the payload — the file is meant to be read.
      assert.match(fs.readFileSync(file, "utf8"), /## Staffing[\s\S]*moonshotai\/Kimi-K3/);
    });

    test("a preset saved before the field existed still parses", () => {
      const { staffing: _dropped, ...old } = aSavedMission({ staffing: staffed });

      const parsed = parseSavedMission(renderSavedMission(old as SavedMission));

      assert.equal(parsed.ok, true);
      assert.equal(parsed.ok && parsed.saved.staffing, undefined);
    });

    test("an unstaffed mission records no field rather than an empty one", () => {
      const file = saveMission(stateDir, "monthly", signedOffState(), "2026-08-09T10:00:00.000Z");

      assert.equal(fs.readFileSync(file, "utf8").includes('"staffing"'), false);
    });
  });
});
