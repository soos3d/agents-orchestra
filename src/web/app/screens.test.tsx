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
import { Screen } from "./screens.js";
import { emptyView, type View } from "./state.js";

const noop = (): void => {};

const viewWith = (patch: Partial<View>): View => ({ ...emptyView(), ...patch });

const draw = (patch: Partial<View>): string =>
  render(<Screen view={viewWith(patch)} send={noop} onSelect={noop} />);

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
    assert.ok(html.includes("running (1)"));
    assert.ok(!html.includes("approve"));
  });
});

describe("criteria", () => {
  test("show how each one is checked, so a criterion nobody can check is visible", () => {
    const html = draw({ status: "running", criteria: [criterion("c1", false)] });

    assert.ok(html.includes("check ▸ command: npm test"));
    assert.ok(html.includes("✗"), "a failed criterion is not marked");
  });

  test("a criterion with no verdict yet is marked neither met nor failed", () => {
    const html = draw({ status: "running", criteria: [criterion("c1")] });

    assert.ok(!html.includes("✗"));
    assert.ok(!html.includes("✓"));
  });
});
