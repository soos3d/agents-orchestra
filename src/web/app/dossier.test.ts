// The failure mode under test: a panel that looks like a spec sheet and is missing the
// row that matters.
//
// Everything here is about what the sheet *says*, which is the half a screenshot cannot
// check. Two of these are rules carried over from the HUD and inverted, and the
// inversion is the point: an absent optional draws no row, but an **empty capability is
// not an absent one**. A code task whose lease is empty can write nothing (defect 23)
// and a spec with no tools was granted nothing — both are facts, and a panel that
// silently omits them reads as "not applicable" when it means "nothing at all".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Task } from "../../domain/task.js";
import { agentFacts, agentLine } from "./dossier.js";

const spec = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "frontend-engineer",
  systemPrompt: "You are…",
  worker: "code",
  transport: { id: "acp", target: "claude" },
  tools: ["Read", "Write", "Bash"],
  model: "claude-opus-5",
  verify: { kind: "command", command: "npm test" },
  ...patch,
});

const task = (patch: Record<string, unknown> = {}): Task =>
  ({
    id: "build-calculator",
    missionId: "m1",
    goal: "make it",
    successCriteria: [],
    satisfies: [],
    motivatedBy: [],
    agentSpec: spec(),
    dependsOn: [],
    status: "running",
    artifacts: [],
    verify: { kind: "command", command: "npm test" },
    attempts: 1,
    budget: { wallMs: 1_800_000 },
    createdAt: "2026-08-15T14:00:00.000Z",
    updatedAt: "2026-08-15T14:00:00.000Z",
    worker: "code",
    branch: "orchestra/build-calculator",
    owns: ["index.html", "calculator.js"],
    ...patch,
  }) as never;

const find = (facts: readonly { label: string; values: readonly string[] }[], label: string) =>
  facts.find((fact) => fact.label === label);

describe("the agent sheet", () => {
  test("names the transport's target, not only its id", () => {
    // "acp" alone does not say which adapter is being launched, and the adapters are
    // pinned per target (§12).
    assert.deepEqual(find(agentFacts(task()), "transport")?.values, ["acp · claude"]);
  });

  test("shows both models when the transport pins a different one", () => {
    const pinned = task({ agentSpec: spec({ transport: { id: "acp", target: "codex", model: "gpt-5" } }) });

    const values = find(agentFacts(pinned), "model")?.values ?? [];
    assert.equal(values.length, 2, "a disagreement between the spec and the transport is hidden");
    assert.ok(values.some((value) => value.includes("gpt-5")));
    assert.ok(values.some((value) => value.includes("claude-opus-5")));
  });

  test("says nothing twice when they agree", () => {
    const agreed = task({ agentSpec: spec({ transport: { id: "cli", model: "claude-opus-5" } }) });

    assert.deepEqual(find(agentFacts(agreed), "model")?.values, ["claude-opus-5"]);
  });

  test("an absent optional draws no row", () => {
    const facts = agentFacts(task());

    assert.equal(find(facts, "from"), undefined, "a spec that named no role drew a roster row");
    assert.equal(find(facts, "writes to"), undefined);
    assert.equal(find(facts, "worktree"), undefined);
  });

  test("a roster role is recorded where it is present", () => {
    const derived = task({ agentSpec: spec({ basedOn: "frontend-engineer" }) });

    assert.deepEqual(find(agentFacts(derived), "from")?.values, ["frontend-engineer"]);
  });

  test("an empty lease says it can write nothing, rather than saying nothing", () => {
    const leaseless = agentFacts(task({ owns: [] }));

    const owns = find(leaseless, "owns");
    assert.ok(owns, "a code task with no lease drew no lease row");
    assert.match(owns.values[0]!, /nothing/);
  });

  test("an empty toolset is drawn, because a worker with no tools is worth reading", () => {
    const unarmed = agentFacts(task({ agentSpec: spec({ tools: [] }) }));

    assert.deepEqual(find(unarmed, "tools")?.values, ["none granted"]);
  });

  test("git rows exist only for the worker kind that has git", () => {
    const research = agentFacts(
      task({ worker: "research", agentSpec: spec({ worker: "research" }), branch: undefined, owns: undefined }),
    );

    assert.equal(find(research, "branch"), undefined, "a research task was given a branch row");
    assert.equal(find(research, "owns"), undefined);
    // §4 and defect 41: it runs in no checkout and may not change the one it stands in.
    assert.match(find(research, "repo")?.values[0] ?? "", /may not change the repo/);
  });

  test("a computer task is plain: no worktree, and it may not change the repo", () => {
    const browsing = agentFacts(
      task({
        worker: "computer",
        agentSpec: spec({ worker: "computer" }),
        branch: undefined,
        owns: undefined,
      }),
    );

    assert.match(find(browsing, "repo")?.values[0] ?? "", /may not change the repo/);
  });

  test("the wall clock is minutes, and the attempt count is drawn at zero", () => {
    const fresh = agentFacts(task({ attempts: 0, budget: { wallMs: 1_800_000 } }));

    assert.deepEqual(find(fresh, "lease")?.values, ["30 min"]);
    // Unlike a HUD counter: zero attempts on a running task is the fact that nothing
    // has been dispatched yet.
    assert.deepEqual(find(fresh, "attempts")?.values, ["0"]);
  });

  test("how the work will be judged is on the sheet", () => {
    const judged = agentFacts(task({ verify: { kind: "judge", rubric: "the page adds two numbers" } }));

    assert.match(find(judged, "verified by")?.values[0] ?? "", /judge: the page adds two numbers/);
  });
});

test("the one-line summary says who, on what, at which model", () => {
  assert.equal(agentLine(task()), "frontend-engineer on acp, claude-opus-5");
});
