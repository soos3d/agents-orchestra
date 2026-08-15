// The failure mode under test: crowding. The run view before U7 drew the strip, the
// criteria, the board, the why panel, the inbox, a note box, three buttons and four
// hundred lines of timeline in one column, so the two things that matter at hour four —
// the board, and whatever is waiting on a human — were somewhere in the middle of a
// page nobody could take in.
//
// What that makes assertable is not the layout, which is CSS, but the *contents*: what
// is on the run view at once, and what is one click away. Every test here is one of
// those two questions, plus the one control that must not silently vanish in a rail.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "preact-render-to-string";
import { type PaneKey } from "./hud.js";
import { RunView } from "./runView.js";
import { emptyView, type View } from "./state.js";

const noop = (): void => {};

const running = (patch: Partial<View> = {}): View => ({
  ...emptyView(),
  status: "executing",
  tasks: new Map([
    [
      "t1",
      {
        id: "t1",
        goal: "pull the June ledger",
        worker: "research",
        status: "running",
        dependsOn: [],
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      } as never,
    ],
  ]),
  ...patch,
});

const draw = (view: View, pane: PaneKey = "board", timeline: readonly string[] = []): string =>
  render(
    <RunView view={view} send={noop} onSelect={noop} pane={pane} onPane={noop} timeline={timeline} />,
  );

describe("the run view", () => {
  // The rule the rails exist to enforce, stated as an assertion: these two are on the
  // page together, always, and nothing else has to be.
  test("shows the board and the inbox at the same time", () => {
    const html = draw(
      running({
        inbox: new Map([["p1", { kind: "permission", id: "p1", text: "Bash — rm -rf build" }]]),
      }),
    );

    assert.ok(html.includes("pull the June ledger"), "the board is missing");
    assert.ok(html.includes("rm -rf build"), "the inbox is missing");
    assert.ok(html.includes("allow"), "a pending permission cannot be answered from the run view");
  });

  test("keeps the timeline one click away rather than at the foot of the board", () => {
    const view = running();
    const log = ["10:02:11  task_status  t1 → running"];

    const board = draw(view, "board", log);
    const timeline = draw(view, "timeline", log);

    assert.ok(!board.includes("task_status"), "four hundred log lines are under the board");
    assert.ok(timeline.includes("task_status"), "the timeline pane draws no timeline");
    assert.ok(!timeline.includes("pull the June ledger"), "two panes are showing at once");
  });

  // The mission's score belongs in sight of the board; how each criterion is checked is
  // reading matter and lives in the contract pane.
  test("keeps the verdicts beside the board and the check lines in the contract", () => {
    const criteria = [
      { id: "c1", statement: "every invoice reconciles", check: { kind: "command", command: "npm test" }, met: true },
    ] as never;

    const board = draw(running({ criteria }));
    const contract = draw(running({ criteria }), "contract");

    assert.ok(board.includes("every invoice reconciles"), "the outcome is not in sight of the board");
    assert.ok(!board.includes("check ▸"), "the check lines crowd the board");
    assert.ok(contract.includes("check ▸ command: npm test"));
  });

  test("counts an empty column rather than dropping it", () => {
    const html = draw(running());

    for (const column of ["todo", "running", "verifying", "blocked", "done"]) {
      assert.ok(html.includes(`>${column} `), `the ${column} column vanished when it emptied`);
    }
  });

  // A centre rail with nothing in it reads as a broken page. It happens for real:
  // between sign-off and the first dispatch there is a mission with no tasks.
  test("says so when there is no board yet", () => {
    const html = draw({ ...emptyView(), status: "executing" });

    assert.ok(html.includes("No tasks yet"));
  });

  test("a running task carries a clock counting from when it was dispatched", () => {
    const html = draw(running());

    assert.ok(/5m \d\ds/.test(html), "a task dispatched five minutes ago shows no elapsed time");
  });

  // The controls moved from under the board into the rail, which is exactly the kind
  // of move that loses a button. Panic in particular has no second route.
  test("keeps every steering control, and pause says what it will do", () => {
    const live = draw(running());
    const paused = draw(running({ paused: true }));

    assert.ok(live.includes("panic"), "panic is not reachable from the run view");
    assert.ok(live.includes("note"), "a note cannot be sent from the run view");
    assert.ok(live.includes(">pause<"));
    assert.ok(paused.includes(">unpause<"), "a paused mission still offers pause");
  });

  // §11: nothing that stops a mission may be the button you press without reading.
  test("styles no steering control as the obvious one", () => {
    assert.ok(!draw(running()).includes('class="primary"'));
  });
});
