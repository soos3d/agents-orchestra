// The failure mode under test: a cost summary that reads as free.
//
// §9.5's whole argument is that a mission run on subscription CLIs spends real money
// and reports `measured: 0`, so any surface that prints one confident total is lying
// by omission. `renderMetrics` is where that rule becomes a line of text a person
// actually reads, which makes it worth asserting rather than eyeballing — the numbers
// are right in `events/metrics.ts` and could still be presented wrongly here.
//
// Formatting is deliberately not pinned. What is pinned is which *facts* survive to
// the page.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type MissionMetrics } from "../events/metrics.js";
import { renderMetrics } from "./render.js";

const metrics = (patch: Partial<MissionMetrics> = {}): MissionMetrics => ({
  missionId: "m1",
  status: "complete",
  rounds: 2,
  quick: false,
  totals: {
    wallMs: 90_000,
    measuredTokens: 12_000,
    estimatedTokens: 0,
    unmeasuredDispatches: 0,
    dispatches: 3,
    pricedFully: true,
  },
  calls: [],
  tasks: [],
  other: [],
  ...patch,
});

const render = (patch: Partial<MissionMetrics> = {}) => renderMetrics(metrics(patch)).join("\n");

describe("renderMetrics", () => {
  test("says outright when part of the bill could not be priced (§9.5)", () => {
    const out = render({
      totals: {
        wallMs: 90_000,
        measuredTokens: 0,
        estimatedTokens: 0,
        unmeasuredDispatches: 4,
        dispatches: 4,
        pricedFully: false,
      },
    });

    assert.match(out, /unpriced/);
    assert.match(out, /4 dispatches/);
    assert.doesNotMatch(out, /every dispatch reported/);
  });

  test("says so when every dispatch did report its usage", () => {
    const out = render();
    assert.match(out, /every dispatch reported/);
    assert.doesNotMatch(out, /unpriced/);
  });

  test("names each decision point separately rather than one orchestration line", () => {
    const out = render({
      calls: [
        { call: "research", calls: 1, wallMs: 9_000, measuredTokens: 12_000, estimatedTokens: 0 },
        { call: "judge", calls: 3, wallMs: 4_000, measuredTokens: 6_000, estimatedTokens: 0 },
      ],
    });

    assert.match(out, /research/);
    assert.match(out, /judge/);
    assert.match(out, /3 calls/);
    assert.match(out, /12,000/);
  });

  test("a task carries what actually ran it, since that is the thing being tuned", () => {
    const out = render({
      tasks: [
        {
          taskId: "t1",
          worker: "code",
          status: "done",
          attempts: 2,
          transport: "acp/claude",
          model: "sonnet",
          wallMs: 61_000,
          measuredTokens: 9_000,
          estimatedTokens: 0,
          input: 8_000,
          output: 1_000,
          cacheRead: 288_446,
          cacheWrite: 34_455,
          ranOn: "claude-opus-4-6",
          unmeasuredDispatches: 0,
        },
      ],
    });

    assert.match(out, /t1/);
    assert.match(out, /acp\/claude/);
    assert.match(out, /sonnet/);
    assert.match(out, /2 tries/);
    assert.match(out, /1m 1s/);
    // The split is the point: input and output are priced 5x apart and cache 10x, so
    // a single total cannot be turned back into money.
    assert.match(out, /in 8,000/);
    assert.match(out, /out 1,000/);
    assert.match(out, /cache 322,901/);
    // The spec said sonnet and opus did the work — ACP never sends the spec's model.
    // Every figure above is attached to the wrong price until this line is read.
    assert.match(out, /ran on claude-opus-4-6, not the sonnet it was planned with/);
  });

  test("says nothing about kinds when the transport did not report them", () => {
    // Absent is not zero (§9.5). An "in 0 · out 0" suffix would claim a session read
    // nothing, which for any real dispatch is false.
    const out = render({
      calls: [{ call: "judge", calls: 1, wallMs: 1_000, measuredTokens: 500, estimatedTokens: 0 }],
    });

    assert.doesNotMatch(out, /in 0/);
    assert.doesNotMatch(out, /cache 0/);
  });

  test("an estimated figure is never presented as a price", () => {
    const out = render({
      totals: {
        wallMs: 90_000,
        measuredTokens: 1_000,
        estimatedTokens: 8_000,
        unmeasuredDispatches: 0,
        dispatches: 2,
        pricedFully: false,
      },
    });

    assert.match(out, /estimated/);
    assert.match(out, /a floor/);
    assert.doesNotMatch(out, /every dispatch reported/);
  });

  test("a task nobody could price says so rather than showing a zero", () => {
    const out = render({
      tasks: [
        {
          taskId: "t1",
          worker: "code",
          status: "done",
          attempts: 1,
          transport: "cli/codex",
          model: "gpt-5",
          wallMs: 61_000,
          measuredTokens: 0,
          estimatedTokens: 0,
          unmeasuredDispatches: 1,
        },
      ],
    });

    assert.match(out, /unpriced/);
  });

  test("groups digits the same way regardless of the machine's locale", () => {
    // These lines get diffed between two runs; a locale-dependent separator is not a
    // property of the mission.
    const out = render({ totals: { ...metrics().totals, measuredTokens: 1_234_567 } });
    assert.match(out, /1,234,567/);
  });
});
