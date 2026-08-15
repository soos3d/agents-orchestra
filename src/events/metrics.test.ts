// The failure mode under test: a breakdown that reads as free.
//
// `spendByPhase` has been folded since Phase 1 and rendered nowhere, so the numbers a
// cost decision needs — which decision point is expensive, which task ran long, how
// much of the bill is invisible — were on disk and unreadable. This is the reader, and
// it is pure for the usual reason: the arithmetic is where it can be wrong silently.
//
// Three of its rules are load-bearing rather than presentational:
//
//  - **Unmeasured is reported, never folded into zero (§9.5).** A mission run entirely
//    on subscription CLIs bills real money and reports `measured: 0`. A summary that
//    printed that as the cost would be worse than printing nothing, so the count of
//    dispatches nobody could price is a first-class figure beside it.
//  - **A phase this version did not write is still reported.** Logs predating the
//    per-call split carry `"orchestration"`, and `src/testing/receipts/` is a real
//    mission's log replayed by the suite. Dropping unrecognised phases would make an
//    old mission's spend silently vanish from its own summary.
//  - **A task that never ran appears at zero.** The absence of a dispatch is the
//    finding on a mission that stalled; omitting the row hides it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spendPhase, zeroSpend, type Spend } from "../domain/budget.js";
import { aCodeTask, aMission, aMissionState, anAgentSpec } from "../testing/fixtures.js";
import { missionMetrics } from "./metrics.js";

const spend = (wallMs: number, measured = 0, unmeasured = 0, dispatches = 1): Spend => ({
  ...zeroSpend(),
  wallMs,
  tokens: { measured, estimated: 0, unmeasured },
  dispatches,
});

describe("missionMetrics", () => {
  test("attributes decision points call by call, in a stable order", () => {
    const state = aMissionState({
      mission: aMission({
        spendByPhase: {
          [spendPhase("judge")]: spend(400, 6_000, 0, 2),
          [spendPhase("research")]: spend(900, 12_000),
        },
      }),
    });

    const { calls } = missionMetrics(state);

    assert.deepEqual(
      calls.map((entry) => entry.call),
      ["research", "judge"],
      "calls are reported in CALL_NAMES order so two runs can be diffed line by line",
    );
    assert.equal(calls[0]!.measuredTokens, 12_000);
    assert.equal(calls[1]!.calls, 2);
  });

  test("a decision point that never ran is not listed at all", () => {
    const state = aMissionState({
      mission: aMission({ spendByPhase: { [spendPhase("plan")]: spend(100, 500) } }),
    });

    assert.deepEqual(
      missionMetrics(state).calls.map((entry) => entry.call),
      ["plan"],
    );
  });

  test("reports a task's wall time, attempts, transport and model", () => {
    const task = aCodeTask({
      id: "t1",
      attempts: 2,
      agentSpec: anAgentSpec({
        model: "sonnet",
        transport: { id: "acp", target: "claude" },
      }),
    });
    const state = aMissionState({
      tasks: [task],
      mission: aMission({ spendByPhase: { t1: spend(61_000, 4_200) } }),
    });

    const [row] = missionMetrics(state).tasks;

    assert.equal(row!.taskId, "t1");
    assert.equal(row!.wallMs, 61_000);
    assert.equal(row!.attempts, 2);
    assert.equal(row!.transport, "acp/claude");
    assert.equal(row!.model, "sonnet");
  });

  test("a task that never ran is reported at zero rather than omitted", () => {
    // On a stalled mission the task with no dispatch is the whole finding.
    const state = aMissionState({ tasks: [aCodeTask({ id: "t1" })], mission: aMission({}) });

    const [row] = missionMetrics(state).tasks;

    assert.equal(row!.taskId, "t1");
    assert.equal(row!.wallMs, 0);
    assert.equal(row!.measuredTokens, 0);
  });

  test("counts what nobody could price instead of calling it zero (§9.5)", () => {
    const state = aMissionState({
      tasks: [aCodeTask({ id: "t1" })],
      mission: aMission({
        spendByPhase: {
          t1: spend(30_000, 0, 1),
          [spendPhase("plan")]: spend(500, 8_000),
        },
      }),
    });

    const metrics = missionMetrics(state);

    assert.equal(metrics.tasks[0]!.unmeasuredDispatches, 1);
    assert.equal(metrics.totals.unmeasuredDispatches, 1);
    assert.equal(metrics.totals.measuredTokens, 8_000);
    assert.equal(
      metrics.totals.pricedFully,
      false,
      "a mission with an unmeasured dispatch must not read as fully priced",
    );
  });

  test("a mission whose every dispatch reported usage is marked fully priced", () => {
    const state = aMissionState({
      tasks: [aCodeTask({ id: "t1" })],
      mission: aMission({ spendByPhase: { t1: spend(30_000, 900) } }),
    });

    assert.equal(missionMetrics(state).totals.pricedFully, true);
  });

  test("a phase from a log this version did not write is reported, not dropped", () => {
    // Logs written before the per-call split carry `"orchestration"`, and the committed
    // receipt in `src/testing/receipts/` is one of them.
    const state = aMissionState({
      mission: aMission({ spendByPhase: { orchestration: spend(700, 5_000, 0, 4) } }),
    });

    const metrics = missionMetrics(state);

    assert.deepEqual(metrics.calls, []);
    assert.deepEqual(metrics.tasks, []);
    assert.equal(metrics.other[0]!.phase, "orchestration");
    assert.equal(metrics.other[0]!.measuredTokens, 5_000);
    assert.equal(metrics.totals.measuredTokens, 5_000, "an unrecognised phase still cost money");
  });

  test("a phase that recorded nothing at all is not listed", () => {
    // `prepare.ts` emits `scan_completed` and `research_completed` carrying a
    // hardcoded `zeroSpend()`, so every mission has a `scan` phase that never held a
    // figure. Listing it invites the reader to conclude the scan was free.
    const state = aMissionState({
      mission: aMission({
        spendByPhase: { scan: zeroSpend(), research: zeroSpend(), legacy: spend(10, 20) },
      }),
    });

    assert.deepEqual(
      missionMetrics(state).other.map((entry) => entry.phase),
      ["legacy"],
    );
  });

  test("totals sum every phase, whatever kind it was", () => {
    const state = aMissionState({
      tasks: [aCodeTask({ id: "t1" })],
      mission: aMission({
        spendByPhase: {
          t1: spend(30_000, 100),
          [spendPhase("plan")]: spend(500, 200),
          legacy: spend(50, 300),
        },
      }),
    });

    const { totals } = missionMetrics(state);

    assert.equal(totals.wallMs, 30_550);
    assert.equal(totals.measuredTokens, 600);
    assert.equal(totals.dispatches, 3);
  });
});
