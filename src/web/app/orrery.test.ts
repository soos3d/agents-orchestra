// The failure mode under test: a picture that is wrong and still looks like a
// dashboard.
//
// Every assertion here is about the two rules the drawing means nothing without. If
// angle stops coming from plan order, a task that starts running jumps across the
// circle and the node a person was watching is gone. If radius stops coming from the
// lifecycle, the shape stops saying how close to finished the mission is — and a ring
// of dots is still a perfectly convincing image of a system working.
//
// Nothing here checks a pixel. What it checks is that the geometry encodes the facts it
// claims to.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { homeCore, layout, missionOrrery, taskOrrery, type OrreryNode } from "./orrery.js";
import { emptyView, type View } from "./state.js";

const viewWith = (patch: Partial<View>): View => ({ ...emptyView(), ...patch });

const task = (id: string, status: string, dependsOn: string[] = []): [string, never] =>
  [id, { id, goal: `goal of ${id}`, worker: "code", status, dependsOn } as never];

const distance = (node: { x: number; y: number }, centre: number): number =>
  Math.hypot(node.x - centre, node.y - centre);

const node = (id: string, patch: Partial<OrreryNode> = {}): OrreryNode => ({
  id,
  label: id,
  title: id,
  ring: "outer",
  tone: "idle",
  active: false,
  ...patch,
});

const idle = homeCore(0, 0);

describe("angle is order", () => {
  test("a task keeps its angle when it starts running", () => {
    const plan = new Map([task("t1", "waiting"), task("t2", "waiting"), task("t3", "waiting")]);
    const before = taskOrrery(viewWith({ tasks: plan }));

    const after = taskOrrery(
      viewWith({ tasks: new Map([task("t1", "waiting"), task("t2", "running"), task("t3", "waiting")]) }),
    );

    const angleOf = (drawing: ReturnType<typeof taskOrrery>, id: string): number => {
      const found = drawing.nodes.find((each) => each.id === id)!;
      return Math.atan2(found.y - drawing.centre, found.x - drawing.centre);
    };

    assert.ok(
      Math.abs(angleOf(before, "t2") - angleOf(after, "t2")) < 1e-9,
      "a task changed status and moved sideways — the eye cannot follow a node that does that",
    );
  });

  test("the first node of a plan is at the top of the circle", () => {
    const drawing = taskOrrery(viewWith({ tasks: new Map([task("t1", "waiting"), task("t2", "waiting")]) }));
    const first = drawing.nodes[0]!;

    assert.ok(Math.abs(first.x - drawing.centre) < 1e-6);
    assert.ok(first.y < drawing.centre);
  });
});

describe("radius is lifecycle", () => {
  test("work falls inward: waiting is outside running is outside done", () => {
    const drawing = taskOrrery(
      viewWith({ tasks: new Map([task("t1", "waiting"), task("t2", "running"), task("t3", "done")]) }),
    );

    const [waiting, running, done] = drawing.nodes.map((each) => distance(each, drawing.centre));

    assert.ok(waiting! > running!, "a waiting task is not outside a running one");
    assert.ok(running! > done!, "a done task is not inside a running one");
  });

  test("a failed task is settled, not still in flight", () => {
    const drawing = taskOrrery(
      viewWith({ tasks: new Map([task("t1", "running"), task("t2", "failed")]) }),
    );

    const [running, failed] = drawing.nodes;
    assert.ok(distance(failed!, drawing.centre) < distance(running!, drawing.centre));
    assert.equal(failed!.tone, "fail");
  });

  test("a status nobody anticipated is drawn as waiting rather than dropped", () => {
    const drawing = taskOrrery(viewWith({ tasks: new Map([task("t1", "quarantined")]) }));

    assert.equal(drawing.nodes.length, 1);
    assert.equal(drawing.nodes[0]!.ring, "outer");
    assert.equal(drawing.nodes[0]!.tone, "idle");
  });
});

describe("threads", () => {
  test("one per declared dependency, and only while both ends exist", () => {
    const drawing = taskOrrery(
      viewWith({ tasks: new Map([task("t1", "done"), task("t2", "running", ["t1"])]) }),
    );

    assert.equal(drawing.edges.length, 1);
    assert.equal(drawing.edges[0]!.id, "t1->t2");
    assert.equal(drawing.edges[0]!.active, true, "a thread into a running task is not lit");
  });

  test("a dependency on a task a replan removed is dropped, not drawn to the corner", () => {
    const drawing = taskOrrery(viewWith({ tasks: new Map([task("t2", "waiting", ["gone"])]) }));

    assert.equal(drawing.edges.length, 0);
  });

  test("a thread bows toward the core rather than crossing it", () => {
    const across = layout(
      [node("a", { ring: "outer" }), node("b", { ring: "outer" })],
      [{ from: "a", to: "b" }],
      idle,
    );
    // Two nodes on the same ring are opposite each other, so a straight chord would run
    // through the core's own label. The control point must be pulled off that line.
    const control = across.edges[0]!.path.match(/Q ([\d.-]+) ([\d.-]+)/);
    assert.ok(control, "the thread is not a quadratic curve");
    assert.ok(
      Math.hypot(Number(control[1]) - across.centre, Number(control[2]) - across.centre) <
        across.coreRadius,
      "the thread is drawn as a straight line across the core",
    );
  });
});

describe("the empty and the one-node cases", () => {
  test("no tasks is a core and three rings, not a crash", () => {
    const drawing = taskOrrery(viewWith({}));

    assert.equal(drawing.nodes.length, 0);
    assert.equal(drawing.edges.length, 0);
    assert.equal(drawing.rings.length, 3);
  });

  test("one task is placed on its ring rather than divided by zero", () => {
    const drawing = taskOrrery(viewWith({ tasks: new Map([task("t1", "running")]) }));

    assert.equal(Number.isFinite(drawing.nodes[0]!.x), true);
    assert.equal(Number.isFinite(drawing.nodes[0]!.y), true);
  });
});

describe("home, which has missions instead of tasks", () => {
  const missions = [
    { id: "20260815T142549Z-make-a-calculator", goal: "make a calculator", status: "executing" },
    { id: "20260814T090000Z-reconcile-invoices", goal: "reconcile invoices", status: "complete" },
  ];

  test("the mission holding a workspace is the live one, whatever its status says", () => {
    const drawing = missionOrrery(
      viewWith({
        missions,
        workspaces: { ...emptyView().workspaces, live: { ws1: missions[0]!.id } },
      }),
    );

    const [live, finished] = drawing.nodes;
    assert.equal(live!.tone, "live");
    assert.equal(live!.active, true);
    assert.equal(finished!.tone, "met");
    assert.ok(distance(finished!, drawing.centre) < distance(live!, drawing.centre));
  });

  test("missions are never threaded together — they do not depend on each other", () => {
    assert.equal(missionOrrery(viewWith({ missions })).edges.length, 0);
  });

  test("the core counts what is running, and spins only then", () => {
    assert.equal(homeCore(3, 1).label, "1 running");
    assert.equal(homeCore(3, 1).spin, true);
    assert.equal(homeCore(3, 0).spin, false);
    assert.equal(homeCore(0, 0).detail, "no missions yet");
  });

  test("a label identifies the mission by the half that differs", () => {
    const drawing = missionOrrery(viewWith({ missions }));

    // Two ids that share a timestamp prefix must not draw two identical labels.
    assert.notEqual(drawing.nodes[0]!.label, drawing.nodes[1]!.label);
  });
});
