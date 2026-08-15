// The failure mode under test: six decision points billed to one line item.
//
// `spend_recorded` carries a `phase`, `fold` aggregates it into `spendByPhase`, and
// dispatch has always written the task's own id there — so the breakdown was real for
// workers and a single bucket for the orchestrator. `createAgentCalls` knew which call
// it had just paid for and handed the name to `onSpend`; `main.ts` took it as `_call`
// and `runCommand.ts` wrote the constant `"orchestration"` instead. The name was
// produced, passed, and dropped one layer from the log.
//
// That is the whole reason "which call is expensive?" was unanswerable, which is the
// question any effort or model change has to be judged against.
//
// The exhaustiveness check below is the other half. A seventh decision point added to
// `Calls` must fail to compile here rather than silently going unattributed — the same
// argument as `fold`'s handler table being a mapped type.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CALL_NAMES, isCallPhase, spendPhase } from "../domain/budget.js";
import { type Calls } from "./calls.js";

describe("decision-point spend phases", () => {
  test("names a phase per call rather than one bucket for all six", () => {
    assert.equal(spendPhase("research"), "call:research");
    assert.equal(spendPhase("judge"), "call:judge");
    assert.notEqual(spendPhase("plan"), spendPhase("synthesize"));
  });

  test("CALL_NAMES covers every decision point on the interface", () => {
    // Typed as a total record, so adding a call to `Calls` without adding it here is a
    // compile error, and the assertion then catches the constant it was left out of.
    const everyCall: Record<keyof Calls, true> = {
      research: true,
      intake: true,
      plan: true,
      synthesize: true,
      progress: true,
      judge: true,
    };

    assert.deepEqual([...CALL_NAMES].sort(), Object.keys(everyCall).sort());
  });

  test("a call phase is distinguishable from a task's phase", () => {
    // `phase` is one field holding two vocabularies: a task id from a model-written
    // plan, and a decision point. A breakdown that cannot tell them apart reports a
    // task called 'research'.
    assert.equal(isCallPhase(spendPhase("progress")), true);
    assert.equal(isCallPhase("build-the-endpoint"), false);
  });

  test("a task id that merely looks like a call phase is not one", () => {
    // Task ids are written by a model and nothing forbids a colon, so the check is
    // membership in the known set rather than a prefix match.
    assert.equal(isCallPhase("call:deploy"), false);
    assert.equal(isCallPhase("call:"), false);
  });
});
