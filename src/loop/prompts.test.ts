// Prompt building is a pure function of folded state (§3), and these assert the two
// halves of that: what it puts in, and what context discipline keeps out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyLedger, type Fact } from "../domain/ledger.js";
import {
  aCodeTask,
  aCriterion,
  aMission,
  aMissionState,
  aProgressLedger,
  aReport,
} from "../testing/fixtures.js";
import { buildPlanInput, buildProgressInput, buildResearchInput } from "./prompts.js";

describe("buildResearchInput", () => {
  test("asks the mission's goal, memory first", () => {
    const input = buildResearchInput(aMissionState());

    assert.match(input.question, /Add a \/health endpoint/);
    assert.equal(input.sources[0], "memory");
  });

  test("carries the known unknowns so research does not start from scratch", () => {
    const state = aMissionState({
      mission: aMission({
        ledger: {
          ...emptyLedger(),
          factsToLookUp: [{ id: "u1", text: "which port the server binds", addedRound: 1 }],
        },
      }),
    });

    assert.match(buildResearchInput(state).question, /which port the server binds/);
  });

  // A saved mission's criteria are a skeleton to converge on, never a result to
  // reuse (§7): the replay re-runs research, and this is how it knows what last
  // month's contract looked like without being handed the outcome.
  // Observed on a real run (2026-08-15): the scan on a quick mission returned findings
  // and no criteria — reasonably, since it had been told it was a scan — so
  // `writeOutcomeSpec` refused `(empty)` and the mission escalated to the deep call it
  // was trying to skip. Quick cost two research calls and saved nothing. The scan has
  // to know when its own answer is the whole of the mission's research.
  describe("the scan on a quick mission", () => {
    test("is told it is the only research pass there will be", () => {
      const state = aMissionState({ mission: aMission({ quick: true }) });

      assert.equal(buildResearchInput(state, "scan").solePass, true);
    });

    test("says nothing of the sort on an ordinary mission", () => {
      assert.equal(buildResearchInput(aMissionState(), "scan").solePass, undefined);
    });

    test("says nothing of the sort on the deep pass, quick or not", () => {
      // On a quick mission the deep call only runs as an escalation, and by then it is
      // emphatically not the sole pass.
      const state = aMissionState({ mission: aMission({ quick: true }) });

      assert.equal(buildResearchInput(state, "deep").solePass, undefined);
    });
  });

  describe("a saved mission's criteria skeleton", () => {
    test("carries the statements, and nothing a previous run concluded", () => {
      const state = aMissionState({
        mission: aMission({
          ledger: {
            ...emptyLedger(),
            criteria: [aCriterion({ statement: "every invoice matched", met: true })],
          },
        }),
      });

      assert.deepEqual(buildResearchInput(state).priorCriteria, [
        { statement: "every invoice matched" },
      ]);
    });

    test("is absent on a mission that has none", () => {
      assert.equal(buildResearchInput(aMissionState()).priorCriteria, undefined);
    });
  });

  // Search before you research (§5): a fact memory already established is research
  // effort that does not have to be spent again. Only memory-sourced facts qualify —
  // this call's own findings are what it is about to write, and handing them back as
  // "already known" would tell it not to do its job.
  describe("what memory already established", () => {
    const withFacts = (facts: Fact[]) =>
      aMissionState({ mission: aMission({ ledger: { ...emptyLedger(), factsVerified: facts } }) });

    const aFact = (patch: Partial<Fact> = {}): Fact => ({
      id: "m1",
      text: "the API client lives in src/net",
      addedRound: 0,
      source: { kind: "memory", ref: "lore-1" },
      observedAt: "2026-07-01T00:00:00.000Z",
      ...patch,
    });

    test("carries memory-sourced facts as known", () => {
      const input = buildResearchInput(withFacts([aFact()]));

      assert.deepEqual(input.known, ["the API client lives in src/net"]);
    });

    test("leaves out facts this mission established itself", () => {
      const state = withFacts([
        aFact(),
        aFact({ id: "f1", text: "routes live in src/routes", source: { kind: "research", ref: "src/routes" } }),
      ]);

      assert.deepEqual(buildResearchInput(state).known, ["the API client lives in src/net"]);
    });

    test("is absent when memory contributed nothing", () => {
      assert.equal(buildResearchInput(aMissionState()).known, undefined);
    });
  });
});

describe("buildPlanInput", () => {
  test("carries the ledger, so a replan cannot re-propose a dead end it can see", () => {
    const state = aMissionState({
      mission: aMission({
        ledger: {
          ...emptyLedger(),
          deadEnds: [
            {
              id: "d1",
              text: "the Ramp API has no read scope on this plan",
              addedRound: 1,
              approach: "pull transactions from the Ramp API",
              evidence: "403 on every call",
              source: "worker",
            },
          ],
        },
      }),
    });

    const input = buildPlanInput(state, "the API approach failed");

    assert.equal(input.ledger.deadEnds.length, 1);
    assert.equal(input.reason, "the API approach failed");
  });

  test("omits the reason on a first plan", () => {
    assert.equal(buildPlanInput(aMissionState()).reason, undefined);
  });
});

describe("buildProgressInput", () => {
  test("carries only this round's reports", () => {
    const state = aMissionState({
      mission: aMission({ round: 4 }),
      reports: [
        { taskId: "t1", round: 3, report: aReport({ summary: "last round" }) },
        { taskId: "t2", round: 4, report: aReport({ summary: "this round" }) },
      ],
    });

    const input = buildProgressInput(state);

    assert.equal(input.reports.length, 1);
    assert.equal(input.reports[0]?.taskId, "t2");
  });

  // `isInLoop` is a question about the last few rounds. One ledger cannot answer it,
  // and every ledger makes round 15 pay for round 1.
  test("carries a bounded window of past ledgers", () => {
    const state = aMissionState({
      progressLedgers: [1, 2, 3, 4, 5].map((round) => ({
        round,
        ledger: aProgressLedger({ instruction: `round ${round}` }),
      })),
    });

    const input = buildProgressInput(state);

    assert.equal(input.recentProgress.length, 3);
    assert.equal(input.recentProgress[2]?.instruction, "round 5");
  });

  test("carries the criteria with their met flags, which the call reads and never infers", () => {
    const state = aMissionState({
      mission: aMission({
        ledger: { ...emptyLedger(), criteria: [aCriterion({ met: true })] },
      }),
    });

    assert.equal(buildProgressInput(state).criteria[0]?.met, true);
  });

  test("names the frontier stranded behind a failure, and what blocks it", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "failed" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });

    const input = buildProgressInput(state);

    assert.deepEqual(input.frontier, [{ taskId: "t2", blockedBy: ["t1"] }]);
  });

  test("reports the counters the loop decides on", () => {
    const state = aMissionState({ mission: aMission({ round: 7, stalls: 2, resets: 1 }) });

    assert.deepEqual(buildProgressInput(state).counters, { round: 7, stalls: 2, resets: 1 });
  });
});
