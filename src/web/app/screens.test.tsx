// The failure mode under test: a screen that renders without the control a human is
// supposed to press. Two of these cost real defects, and both used to be guarded by
// searching the concatenated page for a function name — which proved the code was
// shipped and nothing at all about whether a given view draws the button.
//
// Rendering to a string is the whole apparatus. No DOM, no browser, no socket: a view
// goes in and markup comes out, so the question "does a pending permission get an
// allow button" is answerable in a unit test for the first time.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "preact-render-to-string";
import { type Criterion } from "../../domain/ledger.js";
import { type PaneKey } from "./hud.js";
import { Home, Screen } from "./screens.js";
import { emptyView, type View } from "./state.js";
import { type HealthFrame } from "../protocol.js";

const noop = (): void => {};

const viewWith = (patch: Partial<View>): View => ({ ...emptyView(), ...patch });

/** The board is the pane a run view opens on, so it is what these draw unless the
 *  assertion is about something the rail puts one click away (UI plan U7). */
const draw = (patch: Partial<View>, pane: PaneKey = "board"): string =>
  render(
    <Screen
      view={viewWith(patch)}
      send={noop}
      onSelect={noop}
      pane={pane}
      onPane={noop}
      timeline={[]}
    />,
  );

const criterion = (id: string, met?: boolean): Criterion =>
  ({
    id,
    statement: `${id} holds`,
    check: { kind: "command", command: "npm test" },
    ...(met === undefined ? {} : { met }),
  }) as Criterion;

// A worker is awaiting this one, so a card with no buttons is a mission that hangs
// until the ACP session times out (§12).
describe("a permission request", () => {
  test("is answerable from the inbox", () => {
    const html = draw({
      inbox: new Map([
        ["perm-t1-1", { kind: "permission", id: "perm-t1-1", text: "Bash — rm -rf build" }],
      ]),
    });

    assert.ok(html.includes("Bash — rm -rf build"), "the request is not shown");
    assert.ok(html.includes("allow"), "there is no way to allow it");
    assert.ok(html.includes("deny"), "there is no way to deny it");
  });

  // §11: nothing in the inbox is the button you tap through without reading, so
  // neither answer may be styled as the obvious one.
  test("has no primary button — neither answer is the default", () => {
    const html = draw({
      inbox: new Map([["perm-t1-1", { kind: "permission", id: "perm-t1-1", text: "Bash — x" }]]),
    });

    assert.ok(!html.includes('class="primary"'));
  });
});

// The mid-mission return (§3, §13), defect 29's web half. A reopened mission carries
// the *same* status one field apart, so without the priority order the human is shown
// the original plan and an approve button that approves a change they never saw.
describe("a reopened mission", () => {
  const pendingChange = {
    reasoning: "the second source turned out not to exist",
    diff: [{ op: "remove", criterionId: "c3", reason: "unmeetable as written" }],
  } as View["pendingChange"];

  test("renders the proposed change rather than the plan it already approved", () => {
    const html = draw({ status: "awaiting_signoff", pendingChange, criteria: [criterion("c1")] });

    assert.ok(html.includes("A replan wants to change the contract"));
    assert.ok(html.includes("the second source turned out not to exist"));
    assert.ok(html.includes("unmeetable as written"));
    assert.ok(!html.includes("Awaiting your approval"), "the plan screen is showing underneath");
  });

  test("says what is being rejected, not merely that something changed", () => {
    const html = draw({ status: "awaiting_signoff", pendingChange });

    assert.ok(html.includes("c3"));
    assert.ok(html.includes("reject"));
  });
});

// Intake outranks everything, including a pending contract change: the questions are
// asked before a plan exists to change.
describe("screen priority", () => {
  test("intake wins over sign-off", () => {
    const html = draw({
      status: "awaiting_signoff",
      questions: [{ id: "q1", question: "Which ledger is authoritative?" }],
    });

    assert.ok(html.includes("Which ledger is authoritative?"));
    assert.ok(!html.includes("Awaiting your approval"));
  });

  test("a running mission shows the board and not an approve button", () => {
    const html = draw({
      status: "running",
      tasks: new Map([
        [
          "t1",
          {
            id: "t1",
            goal: "pull the June ledger",
            worker: "research",
            status: "running",
            dependsOn: [],
            startedAt: new Date().toISOString(),
          } as never,
        ],
      ]),
    });

    assert.ok(html.includes("pull the June ledger"));
    assert.ok(html.includes(">running "), "the running column is missing");
    assert.ok(!html.includes("approve"));
  });
});

// UI plan U5. The failure mode this replaces: several minutes of blank page between
// "start mission" and a plan, while a scan, an intake and a research call all happen
// and none of them is drawn. The failure mode it could *introduce* is worse — a
// briefing that makes sign-off feel like a formality — so what is asserted here is
// mostly the second one.
describe("the briefing", () => {
  test("shows what the mission is doing while it is still preparing", () => {
    const html = draw({ status: "researching", scanned: true, findings: 4 });

    assert.ok(html.includes("scan the ground"));
    assert.ok(html.includes("4 findings"), "the scan result is not reported");
    assert.ok(html.includes("research"));
    assert.ok(!html.includes("approve"), "an approve button before there is anything to approve");
  });

  test("the intake screen keeps the trail, because intake is a stage of it", () => {
    const html = draw({
      status: "intake",
      scanned: true,
      intakeAsked: 1,
      questions: [{ id: "q1", question: "Which ledger is authoritative?" }],
    });

    assert.ok(html.includes("Which ledger is authoritative?"));
    assert.ok(html.includes("scan the ground"), "the trail vanished at the first question");
  });

  // The one mitigation the plan names for "a briefing that animates must never make
  // sign-off feel like a formality": the sign-off screen appends. Everything a person
  // read while the mission was specifying is still there, in the same order, and the
  // buttons arrive underneath it rather than in place of it.
  test("sign-off appends to what was already on screen rather than replacing it", () => {
    const specifying = {
      status: "specifying",
      scanned: true,
      brief: "the June ledger lives in Xero",
      criteria: [criterion("c1")],
    } as Partial<View>;

    const before = draw(specifying);
    const after = draw({ ...specifying, status: "awaiting_signoff" });

    assert.ok(before.includes("the June ledger lives in Xero"));
    assert.ok(after.includes("the June ledger lives in Xero"), "the brief was dropped at sign-off");
    assert.ok(after.includes("c1 holds"), "the criteria were dropped at sign-off");
    assert.ok(after.indexOf("approve") > after.indexOf("c1 holds"), "approve sits above the contract");
  });

  test("guesses are above the plan, where they cannot be scrolled past", () => {
    const html = draw({
      status: "awaiting_signoff",
      criteria: [criterion("c1")],
      guesses: [{ id: "g1", text: "the ledger is authoritative", confidence: "low" } as never],
      plan: [
        {
          id: "t1",
          goal: "pull the ledger",
          worker: "code",
          satisfies: ["c1"],
          motivatedBy: [],
          dependsOn: [],
          estimatedWallMs: 240_000,
        } as never,
      ],
    });

    assert.ok(
      html.indexOf("the ledger is authoritative") < html.indexOf("pull the ledger"),
      "a guess is buried under the plan",
    );
  });

  // A criteria change arrives long after preparing is over, and a trail of finished
  // stages above it would frame a contract change as a routine step.
  test("a mid-mission criteria change carries no trail", () => {
    const html = draw({
      status: "awaiting_signoff",
      scanned: true,
      pendingChange: {
        reasoning: "the second source turned out not to exist",
        diff: [{ op: "remove", criterionId: "c3", reason: "unmeetable as written" }],
      } as View["pendingChange"],
    });

    assert.ok(html.includes("A replan wants to change the contract"));
    assert.ok(!html.includes("scan the ground"));
  });

  test("is over once the mission is executing — the board is the better answer", () => {
    const html = draw({
      status: "executing",
      scanned: true,
      tasks: new Map([
        ["t1", { id: "t1", goal: "pull the ledger", worker: "code", status: "running", dependsOn: [] } as never],
      ]),
    });

    assert.ok(!html.includes("scan the ground"));
    assert.ok(html.includes("pull the ledger"), "the board did not replace the trail");
  });
});

// UI plan U4. The failure mode: a compose card that looks the same whichever
// directory it is aimed at. A person about to spend four hours of model time has to
// be able to read where it lands, and the discovery result is the only honest way to
// say it — §2a rule 3 means the page shows what was found and never offers a field to
// declare it.
describe("the compose card", () => {
  const workspace = (id: string, dir: string) => ({ id, path: dir, addedAt: "2026-08-14T00:00:00.000Z" });

  const drawHome = (patch: Partial<View["workspaces"]>): string =>
    render(
      <Home
        view={viewWith({ workspaces: { ...emptyView().workspaces, ...patch } })}
        send={noop}
        onChoose={noop}
      />,
    );

  // The `quick` half of the research/plan optimization is worth nothing if the box is
  // not on the page — the whole design rests on the human declaring a small job rather
  // than a model guessing at one, so this card is where the feature exists or does not.
  // `--unattended` is still absent by design (§17); a cost toggle is not that.
  test("offers the quick toggle, and still never offers unattended", () => {
    const html = drawHome({
      list: [workspace("ws-1", "/Users/dev/ledger")],
      chosen: "ws-1",
      defaultId: "ws-1",
    });

    assert.ok(html.includes("compose-quick"), "the quick toggle is not on the compose card");
    assert.ok(html.includes("quick"), "the quick toggle has no label a person can read");
    assert.equal(html.includes("unattended"), false, "the compose card offered --unattended");
  });

  test("names the directory the mission will run in", () => {
    const html = drawHome({
      list: [workspace("ws-1", "/Users/dev/ledger")],
      chosen: "ws-1",
      defaultId: "ws-1",
    });

    assert.ok(html.includes("/Users/dev/ledger"), "the target directory is not shown");
  });

  // The cap, as the person composing experiences it: not a button that fails, but a
  // button that is already off with the reason beside it.
  test("cannot start a second mission in a directory that already holds one", () => {
    const html = drawHome({
      list: [workspace("ws-1", "/Users/dev/ledger")],
      chosen: "ws-1",
      defaultId: "ws-1",
      live: { "ws-1": "m-7" },
    });

    assert.ok(html.includes("disabled"), "the start button is still live");
    assert.ok(html.includes("m-7"), "the mission holding the directory is not named");
  });

  test("a directory that is not a git repo is stated plainly, not warned about", () => {
    const html = drawHome({
      list: [workspace("ws-1", "/Users/dev/notes")],
      chosen: "ws-1",
      defaultId: "ws-1",
      probe: {
        path: "/Users/dev/notes",
        input: "~/notes",
        id: "ws-2",
        exists: true,
        isDirectory: true,
        agents: ["claude"],
        optionalAgents: [],
        stateDir: "/Users/dev/ledger/.orchestra",
        registered: false,
      },
    });

    assert.ok(html.includes("not a git repo"));
    assert.ok(html.includes("none found"), "a missing verify command is not reported");
    assert.ok(html.includes("add this directory"));
  });

  // A directory that does not exist is the create case, and creating is the act with
  // consequences — so the button says so and the resolved path is above it.
  test("offers to create a directory that is not there, with the resolved path shown", () => {
    const html = drawHome({
      list: [workspace("ws-1", "/Users/dev/ledger")],
      chosen: "ws-1",
      defaultId: "ws-1",
      probe: {
        path: "/Users/dev/new-thing",
        input: "~/new-thing",
        id: "ws-3",
        exists: false,
        isDirectory: false,
        agents: [],
        optionalAgents: [],
        stateDir: "/Users/dev/ledger/.orchestra",
        registered: false,
      },
    });

    assert.ok(html.includes("/Users/dev/new-thing"), "the resolved path is not shown");
    assert.ok(html.includes("create it and add it"));
  });

  // §17's habitual-default rule, asserted rather than remembered: the flag that skips
  // sign-off must stay something a person types on a terminal, twice.
  test("offers no way to skip sign-off", () => {
    const html = drawHome({ list: [workspace("ws-1", "/Users/dev/ledger")], chosen: "ws-1", defaultId: "ws-1" });

    assert.ok(!html.includes("unattended"));
  });
});

describe("criteria", () => {
  test("show how each one is checked, so a criterion nobody can check is visible", () => {
    // On the contract pane: how a criterion is checked is the thing a person reads
    // once, and the run view keeps only the verdicts in sight of the board (U7).
    const html = draw({ status: "running", criteria: [criterion("c1", false)] }, "contract");

    assert.ok(html.includes("check-kind"), "the kind of check is not shown");
    assert.ok(html.includes("npm test"), "the literal command is not shown");
    assert.ok(html.includes("✗"), "a failed criterion is not marked");
  });

  test("a criterion with no verdict yet is marked neither met nor failed", () => {
    const html = draw({ status: "running", criteria: [criterion("c1")] }, "contract");

    assert.ok(!html.includes("✗"));
    assert.ok(!html.includes("✓"));
  });

  // The one check kind that is a warning: a criterion with `none` can never be met,
  // and it must not dress like the two kinds that can.
  test("a criterion nobody can check is flagged, not styled like the others", () => {
    const unchecked = {
      id: "c9",
      statement: "the report reads well",
      check: { kind: "none", reason: "taste is not a command" },
    } as Criterion;
    const html = draw({ status: "running", criteria: [unchecked] }, "contract");

    assert.ok(html.includes("check-none"), "the unchecked criterion is not flagged");
    assert.ok(html.includes("taste is not a command"), "the reason it is unchecked is hidden");
  });
});

describe("the plan on the contract", () => {
  // The row answers why a task exists and what it waits on — the two questions the
  // prose bullets buried.
  test("a task row carries its worker, dependencies, and the criteria it satisfies", () => {
    const html = draw(
      {
        status: "awaiting_signoff",
        criteria: [criterion("c1")],
        plan: [
          {
            id: "t2",
            goal: "reconcile the totals",
            worker: "code",
            satisfies: ["c1"],
            motivatedBy: [],
            dependsOn: ["t1"],
            estimatedWallMs: 300_000,
          } as never,
        ],
      },
    );

    assert.ok(html.includes("reconcile the totals"));
    assert.ok(html.includes("after t1"), "what the task waits on is not shown");
    assert.ok(html.includes("satisfies c1"), "why the task exists is not shown");
  });
});

// ── terminal parity (UI plan U6) ──
//
// The failure mode: a capability that exists only as a typed command while the plan
// claims `orchestra serve` is the only command a person runs. Each of these asserts
// the *control is drawn*, which is the half no server test can see.
describe("the mission listing", () => {
  const mission = (id: string, status: string) => ({ id, goal: `goal of ${id}`, status });

  const drawList = (
    missions: readonly { id: string; goal: string; status: string }[],
    live: Readonly<Record<string, string>> = {},
  ): string =>
    render(
      <Home
        view={viewWith({
          missions,
          workspaces: { ...emptyView().workspaces, list: [], live, defaultId: "ws-1" },
        })}
        send={noop}
        onChoose={noop}
      />,
    );

  test("offers to resume a mission that is parked, and to keep it", () => {
    const html = drawList([mission("m-parked", "blocked")]);

    assert.ok(html.includes("resume"), "a parked mission cannot be carried on from here");
    assert.ok(html.includes("save"), "a finished mission cannot be kept from here");
  });

  // Two missions in one directory is the thing the cap exists to prevent, so the
  // button is not offered for a mission that is already running.
  test("does not offer to resume a mission that is already running", () => {
    const html = drawList([mission("m-live", "executing")], { "ws-1": "m-live" });

    assert.ok(html.includes("running"));
    assert.ok(!html.includes(">resume<"), "a live mission was offered a resume button");
  });

  test("does not offer to resume a mission that is finished", () => {
    const html = drawList([mission("m-done", "complete")]);

    assert.ok(!html.includes(">resume<"));
  });
});

/** A health frame with the machine's answers filled in, so a test names only the field
 *  it is about. Added when the frame grew a harness menu: four more required fields
 *  across four literals is four places to get bored and stop asserting. */
const aHealth = (patch: Partial<HealthFrame> = {}): HealthFrame => ({
  checks: [],
  ready: true,
  transports: ["cli"],
  harnesses: [{ id: "cli/claude", models: ["opus", "sonnet", "haiku"], honoursModel: true }],
  orchestratorModels: ["opus", "sonnet", "haiku"],
  orchestratorModel: "opus",
  fixedModels: [{ name: "progress", model: "sonnet" }],
  ...patch,
});

// `doctor`, on the page. What matters is that the transports line reports what this
// machine can *start* (defect 21) and that a failing check brings its fix with it.
describe("the health panel", () => {
  const drawHealth = (health: View["health"]): string =>
    render(
      <Home
        view={viewWith({ missions: [], health })}
        send={noop}
        onChoose={noop}
      />,
    );

  test("shows each check with the thing to type when it fails", () => {
    const html = drawHealth(aHealth({
      ready: false,
      checks: [
        { name: "node", level: "ok", detail: "v22.4.0" },
        { name: "workers", level: "fail", detail: "no coding agent on PATH", fix: "npm i -g @anthropic-ai/claude-code" },
      ],
      transports: ["cli"],
    }));

    assert.ok(html.includes("v22.4.0"));
    assert.ok(html.includes("no coding agent on PATH"));
    assert.ok(html.includes("npm i -g @anthropic-ai/claude-code"), "a failing check has no fix beside it");
    assert.ok(html.includes("cli"), "the transports line is missing");
  });

  test("says plainly when nothing can be dispatched", () => {
    const html = drawHealth(aHealth({ ready: false, checks: [], transports: [] }));

    assert.ok(html.includes("nothing can be dispatched"));
  });

  test("is absent on a per-run server, which has no registry either", () => {
    const html = render(<Home view={viewWith({ missions: [] })} send={noop} onChoose={noop} />);

    assert.ok(!html.includes("This machine"));
  });
});

// The redesign's own rule, and the one it is easiest to break by tidying: nothing was
// *removed* from home, it was ranked. A control that a person needs once — adding a
// directory, keeping a mission under a name, reading the whole doctor report — is
// folded, and folded is not gone. Every assertion here is about a thing still being on
// the page after being demoted.
describe("home, ranked", () => {
  const workspace = (id: string, dir: string) => ({ id, path: dir, addedAt: "2026-08-14T00:00:00.000Z" });

  const drawHome = (patch: Partial<View>): string =>
    render(<Home view={viewWith(patch)} send={noop} onChoose={noop} />);

  test("a workspace is a button, so it can be chosen without a mouse", () => {
    const html = drawHome({
      workspaces: {
        ...emptyView().workspaces,
        list: [workspace("ws-1", "/Users/dev/ledger")],
        chosen: "ws-1",
        defaultId: "ws-1",
      },
    });

    // The row used to be a div with an onClick, which no keyboard reaches.
    assert.match(html, /<button[^>]*class="ws[^"]*"/);
    assert.ok(html.includes('aria-pressed="true"'), "the chosen row does not say it is chosen");
    // The path is shortened for the rail, so the whole of it has to survive somewhere.
    assert.ok(html.includes('title="/Users/dev/ledger"'));
    assert.ok(html.includes("ledger"));
  });

  test("adding a directory is folded away, and the field is still there", () => {
    const html = drawHome({
      workspaces: { ...emptyView().workspaces, list: [workspace("ws-1", "/Users/dev/ledger")], defaultId: "ws-1" },
    });

    assert.ok(html.includes("<details"), "the add flow is not folded");
    assert.ok(html.includes("another directory"));
    assert.ok(html.includes('id="workspace-path"'), "the directory field was dropped rather than folded");
  });

  test("the doctor report is summarised, and opens by itself when it is bad news", () => {
    const ready = drawHome({
      missions: [],
      health: aHealth({ ready: true, checks: [{ name: "node", level: "ok", detail: "v22.4.0" }] }),
    });
    const broken = drawHome({
      missions: [],
      health: aHealth({
        ready: false,
        checks: [{ name: "workers", level: "fail", detail: "no coding agent on PATH", fix: "npm i -g x" }],
        transports: [],
      }),
    });

    assert.ok(ready.includes("✓ ready"), "a healthy machine does not say so in one line");
    assert.ok(ready.includes("1 checks") || ready.includes("checks"));
    // Folded when there is nothing to do about it; open when there is.
    assert.equal(/<details[^>]*open/.test(ready), false, "the whole report is open on a healthy machine");
    assert.ok(/<details[^>]*open/.test(broken), "a machine that cannot dispatch hides why behind a click");
    assert.ok(broken.includes("npm i -g x"), "the fix was folded out of existence");
  });

  test("keeping a mission is folded, and forgetting one is not", () => {
    const html = drawHome({ missions: [{ id: "m-1", goal: "reconcile june", status: "blocked" }] });

    assert.ok(html.includes("save"), "the save control vanished with the row it was in");
    assert.ok(html.includes("forget"));
    assert.ok(html.includes("watch"));
  });

  test("the field draws one node per mission, each naming what it is", () => {
    const html = drawHome({
      missions: [
        { id: "20260815T142549Z-reconcile-june", goal: "reconcile june", status: "executing" },
        { id: "20260814T090000Z-calculator", goal: "make a calculator", status: "complete" },
      ],
      workspaces: {
        ...emptyView().workspaces,
        live: { "ws-1": "20260815T142549Z-reconcile-june" },
      },
    });

    const nodes = html.match(/class="orb /g) ?? [];
    assert.equal(nodes.length, 2, "the mission field does not have one node per mission");
    // A node is a control and carries the mission's own words, not a coordinate.
    assert.ok(html.includes('aria-label="reconcile june · executing"'));
    assert.ok(html.includes("1 running"), "the core does not say what is in flight");
  });
});

describe("the plan-only toggle", () => {
  test("is offered, and it is not a way to skip sign-off", () => {
    const html = render(
      <Home
        view={viewWith({
          workspaces: {
            ...emptyView().workspaces,
            list: [{ id: "ws-1", path: "/Users/dev/ledger", addedAt: "2026-08-14T00:00:00.000Z" }],
            chosen: "ws-1",
            defaultId: "ws-1",
          },
        })}
        send={noop}
        onChoose={noop}
      />,
    );

    assert.ok(html.includes("plan only"), "there is no way to ask what a mission would take");
    assert.ok(!html.includes("unattended"));
  });
});

// Folded and gone look identical in a diff, which is why every rare control on home has
// an assertion that it is still rendered. These three are the newest of them: the
// harness and the two models sit behind a `<details>` because the defaults suit nearly
// every mission, and a dropped `<select>` would look exactly like a tidy-up.
describe("the harness and model controls", () => {
  const drawCompose = (health: View["health"]): string =>
    render(<Home view={viewWith({ missions: [], health })} send={noop} onChoose={noop} />);

  test("offers a harness and both models, folded", () => {
    const html = drawCompose(aHealth());

    assert.ok(html.includes('id="compose-harness"'), "the harness control was dropped");
    assert.ok(html.includes('id="compose-worker-model"'), "the worker model control was dropped");
    assert.ok(
      html.includes('id="compose-orchestrator-model"'),
      "the orchestrator model control was dropped",
    );
    assert.ok(html.includes("harness and models"), "the fold has no summary to click");
  });

  // Every option has to come from the frame the server sent. A page that composed its
  // own would be free-typing the string that decides which binary gets spawned, and the
  // server would refuse it — a menu whose entries are all rejected is worse than none.
  test("every option offered is one the server sent", () => {
    const html = drawCompose(
      aHealth({
        harnesses: [{ id: "acp/codex", models: ["gpt-x"], honoursModel: false }],
        orchestratorModels: ["haiku"],
      }),
    );

    assert.ok(html.includes("acp/codex"));
    assert.ok(html.includes("gpt-x"));
    assert.ok(!html.includes("cli/claude"), "offered a harness the server did not send");
  });

  test("says which harness will ignore the model choice", () => {
    // The adapter picks its own model and is never told ours. A control that silently
    // did nothing would be worse than no control.
    const html = drawCompose(
      aHealth({ harnesses: [{ id: "acp/claude", models: ["opus"], honoursModel: false }] }),
    );

    assert.ok(html.includes("picks its own model"));
  });

  test("draws nothing at all before the machine has been probed", () => {
    // A menu built from a guess is the one thing this must not do.
    const html = drawCompose(null);

    assert.ok(!html.includes('id="compose-harness"'));
  });

  test("names the orchestrator's harness rather than offering a choice of one", () => {
    const html = drawCompose(aHealth());

    assert.ok(html.includes("Claude Agent SDK"));
  });
});
