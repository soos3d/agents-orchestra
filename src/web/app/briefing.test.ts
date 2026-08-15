// The failure mode under test: a progress trail that lies about what happened.
//
// This one is drawn while a person waits several minutes for a plan, and it is the
// only thing telling them the process is alive — so a stage marked done before its
// evidence landed, or a step reported that was never owed, is worse than the blank
// page it replaces. Three properties carry that, and all three are asserted here:
// exactly one stage runs, `done` is evidence rather than elapsed time, and an intake
// that never happened is absent rather than skipped.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyLedger, type Criterion, type PlannedTask } from "../../domain/ledger.js";
import { briefing, isPreparing, type Stage } from "./briefing.js";
import { emptyView, type View } from "./state.js";

const viewWith = (patch: Partial<View>): View => ({ ...emptyView(), goal: "reconcile June", ...patch });

const stageOf = (stages: readonly Stage[], key: string): Stage => {
  const hit = stages.find((stage) => stage.key === key);
  assert.ok(hit, `no '${key}' stage`);
  return hit;
};

const running = (stages: readonly Stage[]): Stage[] =>
  stages.filter((stage) => stage.state === "running");

const criterion = (id: string): Criterion =>
  ({ id, statement: `${id} holds`, check: { kind: "command", command: "npm test" } }) as Criterion;

const task = (id: string): PlannedTask => ({
  id,
  goal: `do ${id}`,
  worker: "code",
  dependsOn: [],
  satisfies: [],
  motivatedBy: [],
  estimatedWallMs: 60_000,
});

describe("isPreparing", () => {
  test("covers a mission that has only just been created", () => {
    assert.equal(isPreparing(viewWith({ status: "" })), true);
  });

  test("is over once the mission is executing — the board is the better answer", () => {
    assert.equal(isPreparing(viewWith({ status: "executing" })), false);
    assert.equal(isPreparing(viewWith({ status: "complete" })), false);
    assert.equal(isPreparing(viewWith({ status: "blocked" })), false);
  });

  // A worker is waiting on a permission card, and a status this page has not heard
  // yet must not put a progress trail over it (§12).
  test("an unheard status yields to anything already on screen", () => {
    const withInbox = viewWith({
      status: "",
      inbox: new Map([["perm-1", { kind: "permission" as const, id: "perm-1", text: "Bash — rm -rf build" }]]),
    });

    assert.equal(isPreparing(withInbox), false);
  });
});

describe("briefing", () => {
  // The rule the stylesheet depends on: the running row is the only thing that moves,
  // so two of them would make motion mean nothing. Never *more* than one is the
  // invariant; exactly one holds wherever a reached stage is still unfinished.
  test("exactly one stage runs, at every point in the sequence", () => {
    const points: View[] = [
      viewWith({ status: "" }),
      viewWith({ status: "scanning" }),
      viewWith({ status: "intake", scanned: true, findings: 3, intakeAsked: 2 }),
      viewWith({ status: "researching", scanned: true, intakeAsked: 2, intakeAnswered: 2 }),
      viewWith({ status: "specifying", scanned: true, brief: "a brief" }),
      viewWith({ status: "specifying", scanned: true, brief: "a brief", criteria: [criterion("c1")] }),
      viewWith({
        status: "awaiting_signoff",
        scanned: true,
        brief: "a brief",
        criteria: [criterion("c1")],
        plan: [task("t1")],
      }),
    ];

    for (const view of points) {
      assert.equal(running(briefing(view)).length, 1, `status '${view.status}' does not run exactly one stage`);
    }
  });

  // Observed in the browser against a truncated real log: every prepare stage has its
  // evidence, but `signoff_requested` has not landed, so the mission is still
  // `specifying`. Nothing is in flight and the trail says so — pinning it because the
  // tempting fix, running "your call" early, tells a person they are being asked when
  // they are not.
  test("nothing runs when every reached stage is done and the status has not moved", () => {
    const settled = viewWith({
      status: "specifying",
      scanned: true,
      brief: "a brief",
      ledger: { ...emptyLedger(), criteria: [criterion("c1")] },
      plan: [task("t1")],
    });

    assert.equal(running(briefing(settled)).length, 0);
    assert.equal(stageOf(briefing(settled), "signoff").state, "waiting");
  });

  // Two stages share the `specifying` status — the spec is written, then the work is
  // planned — which is the case a status match alone gets wrong.
  test("the spec runs before the plan does, under the one status they share", () => {
    const specifying = viewWith({ status: "specifying", scanned: true, brief: "a brief" });

    assert.equal(stageOf(briefing(specifying), "spec").state, "running");
    assert.equal(stageOf(briefing(specifying), "plan").state, "waiting");

    const specWritten = { ...specifying, ledger: { ...emptyLedger(), criteria: [criterion("c1")] } };
    assert.equal(stageOf(briefing(specWritten), "spec").state, "done");
    assert.equal(stageOf(briefing(specWritten), "plan").state, "running");
  });

  // The conservative direction is the deliberate one: a stage whose event has not
  // arrived stays the unfinished one, so the trail can be behind the mission but never
  // ahead of it. A status is a claim about the process; the event is the evidence.
  test("a stage is never done on the status alone", () => {
    const noEvidence = viewWith({ status: "researching" });
    assert.notEqual(stageOf(briefing(noEvidence), "scan").state, "done");

    assert.equal(stageOf(briefing({ ...noEvidence, scanned: true }), "scan").state, "done");
  });

  // §2b: a mission with no ambiguity is asked nothing at all, and a row reading
  // "0 questions" reports a step that was never owed.
  test("intake is absent when nothing was asked, and present while it is being asked", () => {
    const never = briefing(viewWith({ status: "researching", scanned: true }));
    assert.equal(never.some((stage) => stage.key === "intake"), false);

    const asking = briefing(viewWith({ status: "intake", scanned: true }));
    assert.equal(stageOf(asking, "intake").state, "running");
  });

  test("intake is done only once every question it asked has an answer", () => {
    const half = viewWith({ status: "intake", scanned: true, intakeAsked: 3, intakeAnswered: 1 });
    assert.equal(stageOf(briefing(half), "intake").state, "running");

    const all = { ...half, intakeAnswered: 3 };
    assert.equal(stageOf(briefing(all), "intake").state, "done");
    assert.match(stageOf(briefing(all), "intake").detail, /3 questions · 3 answered/);
  });

  // A scan that turned up nothing is a finished stage, not a missing one — and saying
  // so is the difference between "still working" and "there was nothing to find".
  test("a scan that found nothing is done, and says so", () => {
    const stage = stageOf(briefing(viewWith({ status: "researching", scanned: true, findings: 0 })), "scan");

    assert.equal(stage.state, "done");
    assert.match(stage.detail, /nothing already known/);
  });

  test("reports what each stage actually produced", () => {
    const stages = briefing(
      viewWith({
        status: "awaiting_signoff",
        scanned: true,
        findings: 1,
        brief: "a brief",
        criteria: [criterion("c1"), criterion("c2")],
        guesses: [{ id: "g1", text: "the ledger is authoritative", confidence: "low" } as never],
        plan: [task("t1"), task("t2")],
        estimate: { taskCount: 2, tokens: 1000, wallMs: 21 * 60_000, expectedGates: 0 },
      }),
    );

    assert.match(stageOf(stages, "scan").detail, /1 finding\b/);
    assert.match(stageOf(stages, "spec").detail, /2 criteria · 1 guess\b/);
    assert.match(stageOf(stages, "plan").detail, /2 tasks · ~21 min/);
  });

  // `prepareMission` decides the criteria, revises the ledger with them, and only
  // then plans — `outcome_spec_written` carries the estimate and cannot be emitted
  // before the plan exists. Keying the spec stage on the criteria the view draws would
  // mark it done at the same instant as the plan, and show the two happening in an
  // order they did not happen in.
  test("the spec is done at the ledger revision that carries the criteria, before the plan", () => {
    const specInLedger = viewWith({
      status: "specifying",
      scanned: true,
      brief: "a brief",
      ledger: { ...emptyLedger(), criteria: [criterion("c1")] },
    });

    assert.equal(stageOf(briefing(specInLedger), "spec").state, "done");
    assert.equal(stageOf(briefing(specInLedger), "plan").state, "running");
  });

  // The waiting rows carry no detail: a line describing what a stage will report is a
  // line a person can mistake for what it did report.
  test("a stage that has not run yet reports nothing", () => {
    const stages = briefing(viewWith({ status: "scanning" }));

    for (const stage of stages.filter((each) => each.state === "waiting")) {
      assert.equal(stage.detail, "", `'${stage.key}' reports a result it does not have`);
    }
  });
});
