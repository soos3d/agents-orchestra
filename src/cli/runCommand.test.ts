// The failure mode under test: an answer from the dashboard resolves against the
// *log*, not a waiting port — the question parked its tasks in the fold, and the
// mission may be sitting `blocked` with no loop running when the answer arrives. A
// router that only knew how to feed a waiting port would drop exactly the answers
// that matter most, and an answer to a question nothing asked must be refused, or a
// stale tab's leftover reply resolves the *next* question the mission raises.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { type DiscoveredConfig } from "../config/discover.js";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { scriptedCalls } from "../testing/fixtures.js";
import { aCodeTask, aCriterion, missionCreated, stamp } from "../testing/fixtures.js";
import { resolveCriteriaChange } from "../loop/criteriaChange.js";
import { createWebHuman } from "../web/webHuman.js";
import { handleFromDashboard, runMission, type RunSurface } from "./runCommand.js";
import { type Io } from "./main.js";

const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;
const quietIo: Io = { out: () => {}, err: () => {} };

function storeOf(seed: EventInput[]) {
  const inputs = [...seed];
  return {
    inputs,
    emit: (event: EventInput) => {
      inputs.push(event);
    },
    state: () => fold(stamp(inputs)),
  };
}

const askedMission = (): EventInput[] => [
  missionCreated(),
  { ...orchestrator, type: "task_planned", task: aCodeTask() },
  {
    ...orchestrator,
    taskId: "t1",
    type: "question_asked",
    questionId: "q1",
    question: "Which account?",
    blocks: ["t1"],
  },
];

const route = (store: ReturnType<typeof storeOf>, raw: object) =>
  handleFromDashboard(
    // Parsed shapes only reach the real router via `parseClientMessage`; these tests
    // hand it the already-valid message, which is the same contract.
    raw as Parameters<typeof handleFromDashboard>[0],
    createWebHuman(),
    store,
    "m1",
    quietIo,
    () => {},
  );

describe("handleFromDashboard: answers", () => {
  test("an answer to an open question resolves it and enters the ledger as a note", () => {
    const store = storeOf(askedMission());

    const result = route(store, { kind: "answer", questionId: "q1", answer: "staging" });

    assert.deepEqual(result, { ok: true });
    const answered = store.inputs.find((e) => e.type === "question_answered");
    assert.ok(answered && "answer" in answered && answered.answer === "staging");
    const note = store.inputs.find((e) => e.type === "note_received");
    assert.ok(note && "text" in note && /Which account\?.*staging/.test(note.text));
    // The fold lifts the park — the same thing resume would see.
    assert.equal(store.state().tasks[0]?.status, "waiting");
  });

  test("an answer to a question nothing asked is refused", () => {
    const store = storeOf([missionCreated()]);

    const result = route(store, { kind: "answer", questionId: "ghost", answer: "yes" });

    assert.equal(result.ok, false);
    assert.equal(store.inputs.some((e) => e.type === "question_answered"), false);
  });

  test("a second answer to the same question is refused, not double-applied", () => {
    const store = storeOf(askedMission());
    route(store, { kind: "answer", questionId: "q1", answer: "staging" });

    const again = route(store, { kind: "answer", questionId: "q1", answer: "production" });

    assert.equal(again.ok, false);
    assert.equal(store.inputs.filter((e) => e.type === "question_answered").length, 1);
  });
});

// A permission resolution is routed to the *port* through the web human, not written
// here. The port is the only writer of `permission_resolved` (one writer, one settle —
// see `workers/acp/permissionPort.ts`), so a second one here would record the same
// answer twice and hand two decisions to a worker that asked once.
describe("handleFromDashboard: permissions", () => {
  test("a resolution reaches the human port and writes nothing itself", async () => {
    const store = storeOf([missionCreated()]);
    const human = createWebHuman();
    const pending = human.askPermission!({
      requestId: "perm-t1-1",
      taskId: "t1",
      tool: "Write",
      detail: "src/clamp.ts",
    });

    const result = handleFromDashboard(
      { kind: "resolve", requestId: "perm-t1-1", approved: true },
      human,
      store,
      "m1",
      quietIo,
      () => {},
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(await pending, true);
    assert.equal(store.inputs.some((e) => e.type === "permission_resolved"), false);
  });

  // Defect 29's web half: the mid-mission sign-off is answered through the same
  // `approve`/`revise` pair the initial screen uses, so the only question is whether
  // the click reaches the thing that is waiting. It was reaching nothing before,
  // because nothing was waiting — the CLI had already exited on the park.
  test("an approve from the dashboard resolves a pending criteria change", async () => {
    const store = storeOf([
      missionCreated(),
      {
        ...orchestrator,
        type: "outcome_spec_written",
        criteria: [aCriterion({ id: "c1" })],
        guesses: [],
        outOfScope: [],
        estimate: { taskCount: 1, tokens: 0, wallMs: 1000, expectedGates: 0 },
      },
      { ...orchestrator, type: "signoff_granted", unattended: false },
      {
        ...orchestrator,
        type: "criteria_change_requested",
        diff: [
          {
            op: "amend",
            criterionId: "c1",
            from: aCriterion({ id: "c1" }),
            to: aCriterion({ id: "c1", statement: "GET /health returns 200 and a build sha" }),
            reason: "the deploy check reads the sha",
          },
        ],
        reasoning: "c1 as written cannot be met",
      },
    ]);
    const human = createWebHuman();
    const pending = resolveCriteriaChange({ store, human });

    const result = handleFromDashboard({ kind: "approve" }, human, store, "m1", quietIo, () => {});

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(await pending, { ok: true, approved: true });
    assert.equal(
      store.state().mission.ledger.criteria[0]?.statement,
      "GET /health returns 200 and a build sha",
    );
  });

  test("a rejection from the dashboard keeps the criteria and records the dead end", async () => {
    const store = storeOf([
      missionCreated(),
      {
        ...orchestrator,
        type: "outcome_spec_written",
        criteria: [aCriterion({ id: "c1" })],
        guesses: [],
        outOfScope: [],
        estimate: { taskCount: 1, tokens: 0, wallMs: 1000, expectedGates: 0 },
      },
      { ...orchestrator, type: "signoff_granted", unattended: false },
      {
        ...orchestrator,
        type: "criteria_change_requested",
        diff: [{ op: "remove", criterionId: "c1", reason: "unreachable" }],
        reasoning: "c1 cannot be met",
      },
    ]);
    const human = createWebHuman();
    const pending = resolveCriteriaChange({ store, human });

    handleFromDashboard(
      { kind: "revise", feedback: "c1 stands" },
      human,
      store,
      "m1",
      quietIo,
      () => {},
    );

    assert.deepEqual(await pending, { ok: true, approved: false });
    assert.equal(store.state().mission.ledger.criteria.length, 1);
    assert.equal(store.state().mission.ledger.deadEnds[0]?.source, "human");
  });

  test("a resolution nothing is waiting on is reported rather than swallowed", () => {
    const store = storeOf([missionCreated()]);

    const result = route(store, { kind: "resolve", requestId: "perm-t9-1", approved: true });

    assert.equal(result.ok, false);
  });
});

// The surface path is an optional dependency on RunDeps, which is exactly the shape
// defects 12b, 23, and 24 hid in: built, unit-tested, and wired by nothing. This is
// the wiring test — a mission lent a surface publishes through it, registers before
// it can be spoken to, releases on the way out, and never binds a port of its own.
describe("runMission under a surface", () => {
  test("registers, publishes, and releases without owning a server", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-surface-"));
    const config: DiscoveredConfig = {
      cwd: stateDir,
      stateDir,
      worktreeRoot: path.join(stateDir, "worktrees"),
      agents: [],
      orchestratorModel: "sonnet",
      maxConcurrency: 4,
    };

    const log: string[] = [];
    let publishes = 0;
    const surface: RunSurface = {
      server: { publish: () => publishes++, url: "http://127.0.0.1:0" },
      register: (missionId) => log.push(`register ${missionId}`),
      release: (missionId) => log.push(`release ${missionId}`),
    };

    // An empty script throws on the first decision point, which is the shortest
    // route through the wiring: mission_created has been emitted (so publish ran)
    // and the finally block still has to release.
    await assert.rejects(() =>
      runMission(
        { goal: "wired?", planOnly: false, unattended: false, force: false, web: true, budgetMinutes: 5 },
        config,
        quietIo,
        { createCalls: () => scriptedCalls({}), surface },
      ),
    );

    assert.equal(log.length, 2);
    assert.match(log[0]!, /^register /);
    assert.match(log[1]!, /^release /);
    assert.equal(log[0]!.slice(9), log[1]!.slice(8));
    assert.ok(publishes > 0, "the mission never published through the lent server");
  });

  // `--plan-only` from a terminal takes no port: it prints and exits, and CI has no
  // browser. A *composed* plan-only mission is the opposite case, and the exception is
  // not a convenience (UI plan U6) — plan-only still runs intake, so a mission with no
  // port would ask its questions into a process nobody is attached to and sit there
  // until the budget ran out.
  test("a composed plan-only mission still gets the port its intake needs", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-planonly-"));
    const config: DiscoveredConfig = {
      cwd: stateDir,
      stateDir,
      worktreeRoot: path.join(stateDir, "worktrees"),
      agents: [],
      orchestratorModel: "sonnet",
      maxConcurrency: 4,
    };

    const log: string[] = [];
    const surface: RunSurface = {
      server: { publish: () => {}, url: "http://127.0.0.1:0" },
      register: (missionId) => log.push(`register ${missionId}`),
      release: (missionId) => log.push(`release ${missionId}`),
    };

    await assert.rejects(() =>
      runMission(
        { goal: "what would this take?", planOnly: true, unattended: false, force: false, web: true, budgetMinutes: 5 },
        config,
        quietIo,
        { createCalls: () => scriptedCalls({}), surface },
      ),
    );

    assert.match(log[0] ?? "", /^register /, "a composed plan-only mission was given no surface");
  });
});
