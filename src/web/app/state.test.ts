// The failure mode: the browser's reducer and the server's `fold` disagreeing about one
// event. They are two readers of the same log and the page exists to show what the loop
// decided, so a rule enforced in only one of them is a screen that contradicts the
// mission it is displaying. `criterion_checked` grew panel seats (PLAN-NEXT 6.1) and the
// fold learned to record a seat without applying it; this asserts the browser did too.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aCriterion, missionCreated, stamp } from "../../testing/fixtures.js";
import { type EventInput } from "../../events/schema.js";
import { apply, emptyView, line } from "./state.js";

const orchestrator = { missionId: "m1", actor: "orchestrator" as const };

const evidence = (reasoning: string) => ({
  artifactIds: [],
  checkOutput: "",
  reasoning,
  byTask: [],
});

const view = (inputs: readonly EventInput[]) =>
  stamp([
    missionCreated(),
    {
      ...orchestrator,
      type: "outcome_spec_written",
      criteria: [aCriterion({ id: "c1" })],
      guesses: [],
      outOfScope: [],
      estimate: { taskCount: 1, wallMs: 1000, expectedGates: 0 },
    },
    ...inputs,
  ]).reduce(apply, emptyView());

describe("apply and a judge panel", () => {
  // A 2-1 the panel passes: the dissenting seat arrives last of the three, so a reducer
  // that applied seats would paint the criterion red until the resolved verdict landed.
  test("a seat's own verdict never reaches the criterion", () => {
    const after = view([
      {
        ...orchestrator,
        type: "criterion_checked",
        criterionId: "c1",
        met: true,
        panelSeat: 0,
        lens: "correctness",
        evidence: evidence("seat 0"),
      },
      {
        ...orchestrator,
        type: "criterion_checked",
        criterionId: "c1",
        met: false,
        panelSeat: 1,
        lens: "spec-compliance",
        evidence: evidence("seat 1 dissents"),
      },
    ]);

    assert.equal(after.criteria[0]?.met, undefined);
  });

  test("the resolved verdict is what the screen shows", () => {
    const after = view([
      {
        ...orchestrator,
        type: "criterion_checked",
        criterionId: "c1",
        met: false,
        panelSeat: 2,
        lens: "does-it-run",
        evidence: evidence("the dissent"),
      },
      {
        ...orchestrator,
        type: "criterion_checked",
        criterionId: "c1",
        met: true,
        evidence: evidence("2 for, 1 against"),
      },
    ]);

    assert.equal(after.criteria[0]?.met, true);
  });

  // Every mission before panels existed, and every quick mission since: one unseated
  // event, applied exactly as it always was.
  test("an unseated verdict applies, which is every log written before panels", () => {
    const after = view([
      {
        ...orchestrator,
        type: "criterion_checked",
        criterionId: "c1",
        met: false,
        evidence: evidence("the command failed"),
      },
    ]);

    assert.equal(after.criteria[0]?.met, false);
  });
});

// A panel writes four `criterion_checked` events in a row. Undifferentiated they read as
// a stutter in the timeline rather than as a vote.
describe("line and a judge panel", () => {
  const rendered = (patch: Record<string, unknown>) =>
    line(
      stamp([
        {
          ...orchestrator,
          type: "criterion_checked",
          criterionId: "c1",
          met: true,
          evidence: evidence("x"),
          ...patch,
        } as EventInput,
      ])[0]!,
    );

  test("a seat says which seat and which lens", () => {
    assert.match(rendered({ panelSeat: 1, lens: "spec-compliance" }), /c1 ✓  seat 1 — spec-compliance/);
  });

  test("the resolved verdict is the plain line it always was", () => {
    assert.match(rendered({}), /c1 ✓$/);
    assert.match(rendered({ met: false }), /c1 ✗$/);
  });
});
