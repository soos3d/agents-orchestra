// The failure mode under test: an instrument panel that glows, spins and counts while
// the thing a person came back to the desk for goes unsaid.
//
// Every assertion here is about *what wins*. A HUD is a ranking before it is a layout,
// and the ranking is where it can be wrong in a way no screenshot shows: a mission with
// a question pending and three tasks running looks busy and healthy, and is stopped.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { core, elapsed, panes, vitals } from "./hud.js";
import { emptyView, type InboxItem, type View } from "./state.js";

const viewWith = (patch: Partial<View>): View => ({ ...emptyView(), ...patch });

const task = (id: string, status: string): [string, never] =>
  [id, { id, goal: `goal of ${id}`, worker: "code", status, dependsOn: [] } as never];

const inbox = (kind: InboxItem["kind"]): ReadonlyMap<string, InboxItem> =>
  new Map([["k1", { kind, text: "is the June ledger authoritative?", id: "q1" }]]);

describe("the status core", () => {
  test("a pending question outranks work in flight — the mission is stopped", () => {
    const view = viewWith({
      status: "executing",
      inbox: inbox("question"),
      tasks: new Map([task("t1", "running"), task("t2", "running")]),
    });

    const state = core(view);

    assert.equal(state.label, "needs you");
    assert.equal(state.tone, "attn");
    assert.equal(state.spin, false, "the core spins while a human is being waited on");
  });

  // A permission is the same shape of stop: a worker is mid-turn and will time out.
  test("a pending permission counts the same way", () => {
    assert.equal(core(viewWith({ inbox: inbox("permission") })).label, "needs you");
  });

  // Intake has the whole screen. Counting it here would put "needs you" beside a page
  // that is already nothing but the question.
  test("an intake question is not an inbox card the core counts", () => {
    const state = core(viewWith({ status: "intake", inbox: inbox("intake") }));

    assert.notEqual(state.label, "needs you");
  });

  test("a paused mission does not spin — nothing is dispatched", () => {
    const state = core(viewWith({ status: "executing", paused: true }));

    assert.equal(state.label, "paused");
    assert.equal(state.spin, false);
  });

  test("running is the only state that is cyan", () => {
    const live = core(viewWith({ status: "executing", tasks: new Map([task("t1", "running")]) }));

    assert.equal(live.tone, "live");
    assert.equal(live.spin, true);
    assert.equal(live.detail, "1 task");

    for (const view of [
      viewWith({ status: "verifying" }),
      viewWith({ status: "complete" }),
      viewWith({ status: "failed" }),
      viewWith({ status: "executing", paused: true }),
      viewWith({ inbox: inbox("question") }),
    ]) {
      assert.notEqual(core(view).tone, "live", `${view.status} claimed the accent`);
    }
  });

  test("a failed mission is the one place red is spent", () => {
    assert.equal(core(viewWith({ status: "failed" })).tone, "fail");
    assert.equal(core(viewWith({ status: "abandoned" })).tone, "fail");
  });

  test("a complete mission reports how much of the contract was met", () => {
    const state = core(
      viewWith({
        status: "complete",
        criteria: [
          { id: "c1", statement: "x", check: { kind: "command", command: "npm test" }, met: true },
          { id: "c2", statement: "y", check: { kind: "command", command: "npm test" }, met: false },
        ] as never,
      }),
    );

    assert.equal(state.tone, "met");
    assert.equal(state.detail, "1/2 criteria met");
  });

  // Between rounds nothing is out, and the loop is still working. It turns, because
  // the process is alive; it is not cyan, because cyan means a worker is dispatched.
  test("the loop between rounds turns without claiming the accent", () => {
    const state = core(viewWith({ status: "verifying" }));

    assert.equal(state.spin, true);
    assert.equal(state.tone, "idle");
  });
});

describe("elapsed", () => {
  test("is coarse above an hour, because a run four hours in does not need its seconds", () => {
    assert.equal(elapsed(4 * 3600_000 + 7 * 60_000 + 33_000), "4h 07m");
  });

  test("reads in minutes and seconds under an hour, and seconds under a minute", () => {
    assert.equal(elapsed(7 * 60_000 + 3_000), "7m 03s");
    assert.equal(elapsed(42_000), "42s");
  });

  // The two clocks are a laptop's and a log's, and they disagree. A HUD reading "-3s"
  // reads as a broken orchestrator rather than as a clock that slept.
  test("never runs backwards, whatever the clocks say", () => {
    assert.equal(elapsed(-90_000), "0s");
  });
});

describe("the vitals", () => {
  test("a counter still at zero is not drawn at all", () => {
    const labels = vitals(viewWith({ round: 2 }), 0).map((vital) => vital.label);

    assert.deepEqual(labels, ["round"]);
    assert.ok(!labels.includes("stalls"), "a row that never changes teaches the eye to skip");
  });

  test("a stall appears the moment it is not zero, and it is amber", () => {
    const stalls = vitals(viewWith({ round: 3, stalls: 2 }), 0).find((v) => v.label === "stalls");

    assert.equal(stalls?.value, "2");
    assert.equal(stalls?.tone, "attn");
  });

  test("counts from the log's own start, so a tab opened late reads the real elapsed", () => {
    const startedAt = "2026-08-14T10:00:00.000Z";
    const now = Date.parse("2026-08-14T14:05:00.000Z");

    const value = vitals(viewWith({ startedAt }), now).find((v) => v.label === "elapsed")?.value;

    assert.equal(value, "4h 05m");
  });

  // A criterion checked false is re-checked when a contributor lands (P1), so it is
  // amber and never red — the mission has not failed, it has not finished.
  test("a failed criterion is amber, and a full contract is green", () => {
    const criterion = (id: string, met: boolean) =>
      ({ id, statement: id, check: { kind: "command", command: "npm test" }, met }) as never;

    const failing = vitals(viewWith({ criteria: [criterion("c1", true), criterion("c2", false)] }), 0);
    const done = vitals(viewWith({ criteria: [criterion("c1", true)] }), 0);

    assert.equal(failing.find((v) => v.label === "criteria")?.tone, "attn");
    assert.equal(done.find((v) => v.label === "criteria")?.tone, "met");
    assert.equal(done.find((v) => v.label === "criteria")?.value, "1/1");
  });
});

describe("the panes", () => {
  // A badge that says only "something" makes a person open the pane to find out, which
  // is the click the rail exists to save.
  test("carry counts rather than dots", () => {
    const view = viewWith({
      tasks: new Map([task("t1", "running"), task("t2", "done")]),
      criteria: [{ id: "c1", statement: "x", check: { kind: "command", command: "n" } }] as never,
    });

    const badges = Object.fromEntries(panes(view).map((pane) => [pane.key, pane.badge]));

    assert.equal(badges["board"], "1/2");
    assert.equal(badges["contract"], "1");
  });

  test("say nothing at all before there is anything to count", () => {
    assert.deepEqual(
      panes(emptyView()).map((pane) => pane.badge),
      ["", "", "", ""],
    );
  });
});
