// Prompt building is a pure function of folded state (§3), and these assert the two
// halves of that: what it puts in, and what context discipline keeps out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyLedger } from "../domain/ledger.js";
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
