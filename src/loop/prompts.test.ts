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
import {
  ARCHITECT_INPUT_BUDGET,
  buildArchitectInput,
  buildPlanInput,
  buildProgressInput,
  buildResearchInput,
  designSummary,
  judgeLens,
} from "./prompts.js";
import { PANEL_LENSES } from "./criteria.js";

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

// The architect's input is the whole evidence base rather than a précis of it, which is
// exactly why it needs a ceiling somebody can see: a design written over a summary of the
// findings is a design of something nobody looked at, and a mission with a hundred
// findings would put all of them in the prompt without a number here to fail first.
// The repository map (PLAN-NEXT 8.1). Absent rather than empty is the property worth
// pinning: `research` and `architect` have no tools, and an empty map reads to a call that
// cannot check as "this repository has nothing in it".
describe("the repo map", () => {
  test("rides along on both calls that have no tools", () => {
    const map = "Repository map at HEAD abc1234 — 1 tracked file.\n\n- src/ (1 file)";

    assert.equal(buildResearchInput(aMissionState(), "deep", undefined, map).repoKb, map);
    assert.equal(buildArchitectInput(aMissionState(), [], undefined, [], map).repoKb, map);
  });

  test("is absent when this machine has no map, never empty", () => {
    assert.equal("repoKb" in buildResearchInput(aMissionState()), false);
    assert.equal("repoKb" in buildArchitectInput(aMissionState(), []), false);
  });
});

describe("buildArchitectInput", () => {
  const withFindings = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      claim: `finding ${index}: the router registers routes in a table at module load`,
      source: `src/routes/${index}.ts`,
      sourceKind: "codebase" as const,
      confidence: "high" as const,
    }));

  test("carries the goal, the brief and the findings it was handed", () => {
    const state = aMissionState({ brief: "a router with no health route" });

    const input = buildArchitectInput(state, withFindings(2));

    assert.match(input.goal, /Add a \/health endpoint/);
    assert.equal(input.brief, "a router with no health route");
    assert.equal(input.findings.length, 2);
  });

  // The findings are passed rather than folded because at this point in `prepareMission`
  // they are not on the ledger yet — reading state would hand the architect the *scan's*
  // findings and call them the research pass's.
  test("does not substitute the ledger's facts for the findings it was given", () => {
    const state = aMissionState({
      mission: aMission({
        ledger: {
          ...emptyLedger(),
          factsVerified: [
            {
              id: "f1",
              text: "the scan saw a router",
              addedRound: 0,
              source: { kind: "research", ref: "src/routes" },
              observedAt: "2026-08-16T00:00:00.000Z",
            } as Fact,
          ],
        },
      }),
    });

    const input = buildArchitectInput(state, withFindings(1));

    assert.equal(input.findings.length, 1);
    assert.match(input.findings[0]!.claim, /finding 0/);
  });

  // Intake runs before the architect (§2b). A design settled without the human's answers
  // is a design of the wrong thing, so what they said has to be in this call's input.
  test("carries what the human answered at intake as known facts", () => {
    const state = aMissionState({
      mission: aMission({
        ledger: {
          ...emptyLedger(),
          factsGiven: [
            {
              id: "g1",
              text: "fiscal year, not calendar",
              addedRound: 0,
              source: { kind: "human", ref: "intake" },
              observedAt: "2026-08-16T00:00:00.000Z",
            } as Fact,
          ],
        },
      }),
    });

    assert.deepEqual(buildArchitectInput(state, []).known, ["fiscal year, not calendar"]);
  });

  test("the first call is not told about a rejection that has not happened", () => {
    assert.equal(buildArchitectInput(aMissionState(), []).rejected, undefined);
    assert.equal(buildArchitectInput(aMissionState(), [], "no check").rejected, "no check");
  });

  test("a realistic evidence base fits the budget", () => {
    const state = aMissionState({ brief: "x".repeat(2_000) });

    const rendered = JSON.stringify(buildArchitectInput(state, withFindings(40)));

    assert.ok(
      rendered.length <= ARCHITECT_INPUT_BUDGET,
      `the architect's input is ${rendered.length} characters, over the ${ARCHITECT_INPUT_BUDGET} budget`,
    );
  });
});

// The planner gets a projection of the design note and the worker gets the file. The
// failure mode is the easy one: pasting the whole note into the call that already carries
// the entire ledger.
describe("designSummary", () => {
  test("a short note is carried whole", () => {
    assert.equal(designSummary("# Design\n\nOne module."), "# Design\n\nOne module.");
  });

  test("a long one is cut on a line boundary and says it was cut", () => {
    const note = Array.from({ length: 400 }, (_, i) => `- decision ${i}`).join("\n");

    const summary = designSummary(note);

    assert.ok(summary.length < note.length);
    assert.match(summary, /continues; the full text is on disk/);
    // Cut between lines, so the planner never reads half a decision as a whole one.
    const body = summary.split("\n\n(The design note")[0]!;
    for (const line of body.split("\n")) {
      assert.match(line, /^- decision \d+$/, `'${line}' is half a line`);
    }
  });
});

// The failure mode: three panel seats reading the same paragraph. Quorum over three
// samples of one opinion costs three calls and resolves nothing, so what distinguishes
// the seats has to be asserted rather than assumed from the lens names.
describe("judgeLens", () => {
  test("every lens is a distinct paragraph that names its own seat", () => {
    const texts = PANEL_LENSES.map((lens) => judgeLens(lens));

    assert.equal(new Set(texts).size, PANEL_LENSES.length);
    for (const [index, lens] of PANEL_LENSES.entries()) {
      assert.match(texts[index]!, /Your seat on this panel is/);
      assert.ok(
        texts[index]!.includes(lens.replaceAll("-", " ")),
        `the ${lens} seat does not say which lens it is`,
      );
    }
  });

  // A seat told to grade only its own lens returns `met: true` on work that fails the
  // other two, and the quorum then reads three yeses as agreement.
  test("a lens narrows what a seat weighs, never what it may conclude", () => {
    for (const lens of PANEL_LENSES) {
      assert.match(judgeLens(lens), /Weigh whether/);
      assert.doesNotMatch(judgeLens(lens), /ignore|only judge|do not consider/i);
    }
  });
});
