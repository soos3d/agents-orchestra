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
import { aCodeTask, missionCreated, stamp } from "../testing/fixtures.js";
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
});
