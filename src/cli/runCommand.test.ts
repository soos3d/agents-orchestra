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
import { zeroSpend } from "../domain/budget.js";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { scriptedCalls } from "../testing/fixtures.js";
import { makeRepo } from "../testing/gitRepo.js";
import { aCodeTask, aCriterion, anEnvelope, missionCreated, stamp } from "../testing/fixtures.js";
import { renderSavedMission, savedDir } from "../memory/savedMission.js";
import { resolveCriteriaChange } from "../loop/criteriaChange.js";
import { createWebHuman } from "../web/webHuman.js";
import {
  defaultEnvelope,
  handleFromDashboard,
  parseRunArgs,
  runMission,
  type RunSurface,
} from "./runCommand.js";
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
        estimate: { taskCount: 1, wallMs: 1000, expectedGates: 0 },
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
        estimate: { taskCount: 1, wallMs: 1000, expectedGates: 0 },
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
        { goal: "wired?", planOnly: false, quick: false, moonshot: false, unattended: false, force: false, web: true, budgetMinutes: 5, runtime: {}, staffing: {}, scanners: [], env: [], research: "closed", domains: [] },
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
  
    };

    const log: string[] = [];
    const surface: RunSurface = {
      server: { publish: () => {}, url: "http://127.0.0.1:0" },
      register: (missionId) => log.push(`register ${missionId}`),
      release: (missionId) => log.push(`release ${missionId}`),
    };

    await assert.rejects(() =>
      runMission(
        { goal: "what would this take?", planOnly: true, quick: false, moonshot: false, unattended: false, force: false, web: true, budgetMinutes: 5, runtime: {}, staffing: {}, scanners: [], env: [], research: "closed", domains: [] },
        config,
        quietIo,
        { createCalls: () => scriptedCalls({}), surface },
      ),
    );

    assert.match(log[0] ?? "", /^register /, "a composed plan-only mission was given no surface");
  });
});

// The failure mode under test: the decision point's name produced, passed, and then
// dropped one layer above the log.
//
// `createAgentCalls` has always handed `onSpend` the call it just paid for, and both
// composition roots threw it away — `main.ts` took it as `_call`, and this file wrote
// the constant `"orchestration"`. Six calls, one line item, and "which call is
// expensive?" unanswerable. `spendPhase` is unit-tested next to `Calls`; what nothing
// covered is whether the wiring in between still carries the argument, which is the
// `buildLoopDeps` lesson: an optional dependency can be built, tested, and reachable
// through a parameter no entry point passes.
describe("runMission spend attribution", () => {
  test("records a decision point under its own phase, not one bucket", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-spend-"));
    const config: DiscoveredConfig = {
      cwd: stateDir,
      stateDir,
      worktreeRoot: path.join(stateDir, "worktrees"),
      agents: [],
      orchestratorModel: "sonnet",
  
    };

    await assert.rejects(() =>
      runMission(
        { goal: "who spent it?", planOnly: true, quick: false, moonshot: false, unattended: true, force: true, web: false, budgetMinutes: 5, runtime: {}, staffing: {}, scanners: [], env: [], research: "closed", domains: [] },
        config,
        quietIo,
        {
          // Spends, then refuses — the shortest route that puts a `spend_recorded` on
          // disk. The scan is the first decision point a mission reaches.
          createCalls: (_config, onSpend) => ({
            ...scriptedCalls({}),
            research: async () => {
              onSpend("research", { ...zeroSpend(), tokens: { measured: 1234, estimated: 0, unmeasured: 0 } });
              throw new Error("stop here");
            },
          }),
        },
      ),
    );

    const missions = path.join(stateDir, "missions");
    const [missionId] = fs.readdirSync(missions);
    const events = fs
      .readFileSync(path.join(missions, missionId!, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; phase?: string; spend?: { tokens: { measured: number } } });

    const recorded = events.find((event) => event.type === "spend_recorded");
    assert.ok(recorded, "the mission spent measured tokens and recorded nothing");
    assert.equal(recorded.phase, "call:research");
    assert.equal(recorded.spend?.tokens.measured, 1234);
  });
});

// The terminal half of the harness choice, and the reason it is tested at all: a flag
// that takes a value has a failure mode a boolean flag does not — `--harness --quick`
// silently eats the next flag as its value, and the mission then runs on a harness
// called "--quick" and without the flag that was typed.
describe("parseRunArgs and the runtime flags", () => {
  const parse = (argv: readonly string[]) => parseRunArgs(argv);

  test("a run with no runtime flags chooses nothing", () => {
    const parsed = parse(["do the thing"]);

    assert.equal(parsed.ok, true);
    // Empty rather than populated with defaults: "nothing was chosen" has to survive
    // all the way to the log, where it means "whatever this machine offers".
    assert.deepEqual(parsed.ok ? parsed.options.runtime : undefined, {});
  });

  test("carries all three choices through", () => {
    const parsed = parse([
      "do the thing",
      "--harness",
      "acp/claude",
      "--worker-model",
      "haiku",
      "--orchestrator-model",
      "sonnet",
    ]);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok ? parsed.options.runtime : undefined, {
      harness: "acp/claude",
      workerModel: "haiku",
      orchestratorModel: "sonnet",
    });
  });

  test("a runtime flag with no value is refused rather than eating the next flag", () => {
    for (const argv of [
      ["goal", "--harness"],
      ["goal", "--harness", "--quick"],
      ["goal", "--worker-model", "--plan-only"],
      ["goal", "--orchestrator-model"],
    ]) {
      const parsed = parse(argv);
      assert.equal(parsed.ok, false, `accepted a valueless flag: ${argv.join(" ")}`);
      // §2a rule 5: the message shows what to type instead.
      assert.match(parsed.ok === false ? parsed.message : "", /e\.g\./);
    }
  });

  test("the runtime flags do not read as unknown flags", () => {
    const parsed = parse(["goal", "--harness", "cli/codex", "--quick"]);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok ? parsed.options.quick : undefined, true);
  });
});

// The moonshot profile (PLAN-NEXT 8.2). What is asserted is the pair: a preset that
// reaches the mission, and the one combination that cannot mean anything — a job cannot
// be both small enough to skip the deep research pass and worth a second critic round,
// and a log carrying both is a mission nobody can say the shape of.
describe("parseRunArgs and --moonshot", () => {
  test("the flag reaches the options, and absent is a standard mission", () => {
    const standard = parseRunArgs(["reconcile it"]);
    const moonshot = parseRunArgs(["reconcile it", "--moonshot"]);

    assert.equal(standard.ok ? standard.options.moonshot : undefined, false);
    assert.equal(moonshot.ok ? moonshot.options.moonshot : undefined, true);
  });

  test("--quick and --moonshot together are refused, with the fix named", () => {
    const parsed = parseRunArgs(["reconcile it", "--quick", "--moonshot"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : "", /--quick and --moonshot/);
    assert.match(parsed.ok === false ? parsed.message : "", /Drop whichever/);
  });
});

// `--staff research=<card>,plan=<card>`. Two of its three refusals live here, and both
// are the kind a person hits at the terminal: a decision point that cannot be staffed,
// and a pair with no `=` in it. The third — a card nobody probed — belongs to
// `resolveStaffing`, which has the filesystem this parser deliberately does not.
describe("parseRunArgs and --staff", () => {
  test("a run with no --staff staffs nothing", () => {
    const parsed = parseRunArgs(["do the thing"]);

    assert.deepEqual(parsed.ok ? parsed.options.staffing : undefined, {});
  });

  test("carries a card per decision point", () => {
    const parsed = parseRunArgs([
      "goal",
      "--staff",
      "research=nebius/one, plan=nebius/two",
    ]);

    assert.deepEqual(parsed.ok ? parsed.options.staffing : undefined, {
      research: "nebius/one",
      plan: "nebius/two",
    });
  });

  // A judge reads the artifacts it grades, and a chat completion holds no tools: staffing
  // one to a card would fail correct work and say honestly that it could not open the
  // files. The refusal says that rather than only listing what is allowed.
  test("refuses judge, and says why", () => {
    const parsed = parseRunArgs(["goal", "--staff", "judge=nebius/one"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : "", /Read, Glob and Grep/);
  });

  test("refuses a decision point that does not exist, naming the ones that do", () => {
    // `architect` used to be the example here and is a decision point since PLAN-NEXT 5,
    // so the refusal is shown against a name that is still not one.
    const parsed = parseRunArgs(["goal", "--staff", "deploy=nebius/one"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : "", /staffable: research, architect, intake/);
  });

  test("refuses a pair with no card and shows the shape", () => {
    for (const value of ["plan", "plan=", "=nebius/one"]) {
      const parsed = parseRunArgs(["goal", "--staff", value]);
      assert.equal(parsed.ok, false, `accepted '${value}'`);
      assert.match(parsed.ok === false ? parsed.message : "", /e\.g\./);
    }
  });

  test("--staff with no value is refused rather than eating the next flag", () => {
    const parsed = parseRunArgs(["goal", "--staff", "--quick"]);

    assert.equal(parsed.ok, false);
  });
});

// The optional-`Deps` trap, one field along: `staffing` is threaded through four
// composition roots, and a feature that is finished and switched off at the same time is
// what happens when one of them drops it. So the root is what is asserted here — that the
// mission's own choice reaches the thing that builds its calls, and that a card nobody
// verified is refused before a mission directory exists rather than at the first call.
describe("runMission and staffing", () => {
  const aConfig = (): DiscoveredConfig => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-staffing-"));
    return {
      cwd: stateDir,
      stateDir,
      worktreeRoot: path.join(stateDir, "worktrees"),
      agents: [],
      orchestratorModel: "sonnet",
  
    };
  };

  const options = (staffing: Record<string, string>) => ({
    goal: "staffed?",
    planOnly: true,
    quick: false,
    moonshot: false,
    unattended: false,
    force: false,
    web: false,
    budgetMinutes: 5,
    runtime: {},
    staffing,
    scanners: [],
    env: [],
    research: "closed" as const,
    domains: [],
  });

  test("hands the mission's staffing to whatever builds its calls", async () => {
    const seen: unknown[] = [];

    await assert.rejects(() =>
      runMission(options({}), aConfig(), quietIo, {
        createCalls: (_config, _onSpend, staffing) => {
          seen.push(staffing);
          return scriptedCalls({});
        },
      }),
    );

    assert.deepEqual(seen, [{}]);
  });

  test("refuses a card this machine never probed, before the log opens", async () => {
    const config = aConfig();
    const errors: string[] = [];
    const io = { out: () => {}, err: (line: string) => errors.push(line) };

    const code = await runMission(options({ plan: "invented/card" }), config, io, {
      createCalls: () => scriptedCalls({}),
    });

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /invented\/card/);
    // Nothing was written: a refusal that leaves a mission directory behind has already
    // started the mission it was refusing.
    assert.equal(fs.existsSync(path.join(config.stateDir, "missions")), false);
  });

  // The same door, one source along (PLAN-NEXT 11.2). A staffing choice that survives into
  // a preset is a card id nobody re-typed, so it is also a card id nobody re-checked: the
  // machine that replays the preset may not be the machine that saved it, and a probe
  // transcript can be deleted between the two. Falling through to the Agent SDK there would
  // silently run the mission on a model nobody chose and bill it to the wrong ceiling.
  test("refuses an unprobed card that arrived from a saved preset, not a flag", async () => {
    const config = aConfig();
    fs.mkdirSync(savedDir(config.stateDir), { recursive: true });
    fs.writeFileSync(
      path.join(savedDir(config.stateDir), "kimi-deepseek.md"),
      renderSavedMission({
        name: "kimi-deepseek",
        goal: "reconcile the invoices",
        envelope: anEnvelope(),
        criteriaSkeleton: [],
        intakeAnswers: [],
        staffing: { plan: "invented/card" },
        savedAt: "2026-08-17T10:00:00.000Z",
        fromMissionId: "m1",
      }),
    );

    const errors: string[] = [];
    const code = await runMission(
      { ...options({}), goal: "", saved: "kimi-deepseek" },
      config,
      { out: () => {}, err: (line: string) => errors.push(line) },
      { createCalls: () => scriptedCalls({}) },
    );

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /invented\/card/);
    assert.equal(fs.existsSync(path.join(config.stateDir, "missions")), false);
  });

  // The same trap one grant along: `runMission` is the only site that holds both the
  // envelope's web grant and the mission's staffing, so a refusal implemented in
  // `resolveStaffing` and never passed the grant is a rule that is switched off.
  test("refuses --research-web beside a staffed research call, before the log opens", async () => {
    const config = aConfig();
    const errors: string[] = [];
    const io = { out: () => {}, err: (line: string) => errors.push(line) };

    const code = await runMission(
      { ...options({ research: "some/card" }), research: "web" as const },
      config,
      io,
      { createCalls: () => scriptedCalls({}) },
    );

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /--research-web cannot be combined/);
    assert.equal(fs.existsSync(path.join(config.stateDir, "missions")), false);
  });
});

// The optional-`Deps` trap in its 6.3 shape. `PrepareDeps.scanners` can be built,
// unit-tested and reachable through a parameter no entry point passes — which is
// `requestExtension`, `owns` and `reformat` three times over. What is asserted here is
// the wiring: the flag reaches the envelope, and the envelope reaches the architect.
describe("runMission and the scanner grant", () => {
  const aResearch = () => ({
    brief: "there is a script to look at",
    findings: [
      {
        claim: "scripts/deploy.sh shells out",
        source: "scripts/deploy.sh",
        sourceKind: "codebase" as const,
        confidence: "high" as const,
      },
    ],
    confidence: "high" as const,
  });

  const withScan = (scanners: string[]) => ({
    goal: "scan it",
    planOnly: true,
    quick: false,
    moonshot: false,
    unattended: true,
    force: true,
    web: false,
    budgetMinutes: 5,
    runtime: {},
    staffing: {},
    scanners,
    env: [],
    research: "closed" as const,
    domains: [],
  });

  const scanConfig = (stateDir: string, probed?: string[]): DiscoveredConfig => ({
    cwd: stateDir,
    stateDir,
    worktreeRoot: path.join(stateDir, "worktrees"),
    agents: [],
    orchestratorModel: "sonnet",

    ...(probed ? { scanners: probed } : {}),
  });

  /** What the architect was actually offered, which is the question. */
  const offeredTo = async (options: ReturnType<typeof withScan>, probed?: string[]) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-scan-"));
    const seen: (string[] | undefined)[] = [];

    await assert.rejects(() =>
      runMission(options, scanConfig(stateDir, probed), quietIo, {
        createCalls: () => ({
          // Scan, intake and the deep pass all run before the architect, so the shortest
          // route to the call under test is to script them and stop there.
          ...scriptedCalls({
            research: [aResearch(), aResearch()],
            intake: [{ questions: [] }],
          }),
          architect: async (input) => {
            seen.push(input.scanners);
            throw new Error("stop here");
          },
        }),
      }),
    );
    return seen;
  };

  test("--scan reaches the architect when this machine answered for the scanner", async () => {
    assert.deepEqual(await offeredTo(withScan(["deepsec"]), ["deepsec"]), [["deepsec"]]);
  });

  // Both halves or neither. A grant on a machine with no binary is a criterion staffed
  // against something that cannot run — defect 21 in the checking layer.
  test("a grant on a machine without the binary offers nothing", async () => {
    assert.deepEqual(await offeredTo(withScan(["deepsec"]), []), [undefined]);
  });

  test("a mission that did not ask is offered nothing, however installed the machine is", async () => {
    assert.deepEqual(await offeredTo(withScan([]), ["deepsec"]), [undefined]);
  });
});

// A flag that takes a value has the failure mode a boolean does not (`--harness --quick`
// eating the next flag), and this one also grants a capability — so an unknown name is a
// refusal rather than a grant nothing can honour.
describe("parseRunArgs and --scan", () => {
  test("grants a known scanner", () => {
    const parsed = parseRunArgs(["do it", "--scan", "deepsec"]);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.options.scanners, ["deepsec"]);
  });

  test("a mission that did not type it grants none", () => {
    const parsed = parseRunArgs(["do it"]);

    assert.deepEqual(parsed.ok && parsed.options.scanners, []);
  });

  test("an unknown name is refused and the message lists the real ones", () => {
    const parsed = parseRunArgs(["do it", "--scan", "snyk"]);

    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.message : "", /Known scanners: deepsec/);
  });

  test("--scan with no value does not eat the next flag", () => {
    const parsed = parseRunArgs(["do it", "--scan", "--quick"]);

    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.message : "", /--scan takes a scanner name/);
  });
});

// PLAN-NEXT 7.1: the human's half of the secrets flow. A grant of a *name*, which is
// what `Envelope.env` has always been (defect 42) — the value is read from this
// machine's environment at dispatch and never typed, logged or stored.
describe("--env", () => {
  test("granting names puts them in the mission's envelope", () => {
    const parsed = parseRunArgs(["do it", "--env", "STRIPE_KEY", "--env", "SLACK_TOKEN"]);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.options.env, ["STRIPE_KEY", "SLACK_TOKEN"]);
    const envelope = defaultEnvelope(
      { cwd: "/repo", stateDir: "/state", worktreeRoot: "/w", agents: [], orchestratorModel: "sonnet" },
      { wallMs: 60_000 },
      [],
      parsed.ok ? parsed.options.env : [],
    );
    assert.deepEqual(envelope.env, ["STRIPE_KEY", "SLACK_TOKEN"]);
  });

  test("a mission that did not type it grants none", () => {
    const parsed = parseRunArgs(["do it"]);

    assert.deepEqual(parsed.ok && parsed.options.env, []);
  });

  // The refusal that matters. Accepting this would grant a variable literally named
  // `STRIPE_KEY=sk_live_…` — nothing, granted — with a live key now in the shell
  // history and in `mission_created`.
  test("a name=value pair is refused, and the message does not echo the value", () => {
    const parsed = parseRunArgs(["do it", "--env", "STRIPE_KEY=sk_live_9d8f7a6b"]);

    assert.equal(parsed.ok, false);
    const message = !parsed.ok ? parsed.message : "";
    assert.match(message, /--env takes a name, never a value/);
    assert.equal(message.includes("sk_live_9d8f7a6b"), false, "the refusal quoted the key back");
  });

  // A base64 credential ends in `=`, so the `=` the refusal splits on is its last
  // character — and truncating to it printed the whole key to stderr, twice, in the one
  // error whose entire purpose is that the key was typed where it should not have been.
  test("a base64 value ending in = is truncated like any other", () => {
    const key = "c2VjcmV0X3ZhbHVlX2xvbmdfZW5vdWdo=";
    const parsed = parseRunArgs(["do it", "--env", key]);

    assert.equal(parsed.ok, false);
    const message = !parsed.ok ? parsed.message : "";
    assert.equal(message.includes(key), false, "the refusal quoted the whole key back");
    assert.equal(message.includes(key.slice(0, 9)), false, "more than 8 characters survived");
    assert.match(message, /--env takes a name, never a value/);
  });

  test("--env with no value does not eat the next flag", () => {
    const parsed = parseRunArgs(["do it", "--env", "--quick"]);

    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.message : "", /--env takes a variable name/);
  });
});

// A grant nothing is ever told about is a flag that reads as honoured and does nothing.
// A quick mission's spec is `research`'s, and `research` is never offered a scanner.
describe("--scan and --quick", () => {
  test("are refused together, with the reason", () => {
    const parsed = parseRunArgs(["do it", "--quick", "--scan", "deepsec"]);

    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.message : "", /criteria are written by the research scan/);
  });

  test("either one alone is fine", () => {
    assert.equal(parseRunArgs(["do it", "--quick"]).ok, true);
    assert.equal(parseRunArgs(["do it", "--scan", "deepsec"]).ok, true);
  });
});

// An optional `Deps` field is a place a feature can be finished and switched off at once
// (defects 12b, 23, 24), and the repo map is one: `prepareMission` never touches disk, so
// the map exists only if this composition root builds it. What is asserted is the wiring —
// that the two tool-less calls are handed a map when the mission has a repository at all.
describe("the repo map reaches the calls that cannot look", () => {
  test("research and the architect are both given one", async () => {
    const repo = await makeRepo("orchestra-run-kb-");
    const seen: (string | undefined)[] = [];

    try {
      await assert.rejects(() =>
        runMission(
          {
            goal: "map it",
            planOnly: true,
            quick: false,
    moonshot: false,
            unattended: true,
            force: true,
            web: false,
            budgetMinutes: 5,
            runtime: {},
            staffing: {},
            scanners: [],
            env: [],
            research: "closed",
            domains: [],
          },
          {
            cwd: repo.path,
            repoRoot: repo.path,
            stateDir: path.join(repo.path, ".orchestra"),
            worktreeRoot: path.join(repo.path, ".orchestra", "worktrees"),
            agents: [],
            orchestratorModel: "sonnet",
        
          },
          quietIo,
          {
            createCalls: () => ({
              ...scriptedCalls({
                research: [
                  { brief: "b", findings: [], confidence: "high" as const },
                  { brief: "b", findings: [], confidence: "high" as const },
                ],
                intake: [{ questions: [] }],
              }),
              research: async (input) => {
                seen.push(input.repoKb);
                return { brief: "b", findings: [], confidence: "high" as const };
              },
              architect: async (input) => {
                seen.push(input.repoKb);
                throw new Error("stop here");
              },
            }),
          },
        ),
      );

      assert.equal(seen.length > 1, true, "the architect was never reached");
      for (const map of seen) assert.match(map ?? "", /Repository map at HEAD/);
    } finally {
      repo.cleanup();
    }
  });
});

// The failure mode: a grant that reads as honoured and does nothing — accepted beside
// `--quick`, whose only research pass is the toolless scan — or a `--domain` that never
// matches because a URL was typed where a host belongs (PLAN-NEXT 11.3).
describe("--research-web and --domain", () => {
  test("absent is the closed mission every log before this recorded", () => {
    const parsed = parseRunArgs(["do the thing"]);

    assert.equal(parsed.ok && parsed.options.research, "closed");
    assert.deepEqual(parsed.ok ? parsed.options.domains : undefined, []);
  });

  test("the grant and its hosts reach the options", () => {
    const parsed = parseRunArgs([
      "do the thing",
      "--research-web",
      "--domain",
      "docs.python.org",
      "--domain",
      "nodejs.org",
    ]);

    assert.equal(parsed.ok && parsed.options.research, "web");
    assert.deepEqual(parsed.ok ? parsed.options.domains : undefined, [
      "docs.python.org",
      "nodejs.org",
    ]);
  });

  test("--research-web with --quick is refused with the fix named", () => {
    const parsed = parseRunArgs(["do the thing", "--research-web", "--quick"]);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.message, /Drop --quick/);
  });

  test("a URL or a wildcard is refused, since the allowlist is exact hosts", () => {
    const url = parseRunArgs(["g", "--domain", "https://docs.python.org/3/"]);
    assert.equal(url.ok, false);
    assert.match(url.ok ? "" : url.message, /--domain docs\.python\.org/);

    assert.equal(parseRunArgs(["g", "--domain", "*.python.org"]).ok, false);
  });

  test("the envelope carries the grant, which is what a resume folds", () => {
    const envelope = defaultEnvelope(
      { cwd: "/repo", stateDir: "/repo/.orchestra", worktreeRoot: "/w", agents: [], orchestratorModel: "sonnet" },
      { wallMs: 1000 },
      [],
      [],
      "web",
      ["docs.python.org"],
    );

    assert.equal(envelope.research, "web");
    assert.deepEqual(envelope.domains, ["docs.python.org"]);
    assert.equal(defaultEnvelope({ cwd: "/repo", stateDir: "/repo/.orchestra", worktreeRoot: "/w", agents: [], orchestratorModel: "sonnet" }, { wallMs: 1000 }).research, "closed");
  });
});
