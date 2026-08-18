// The failure mode under test: two transports telling a worker two different things.
//
// The prompt is the only thing a worker receives (§4, context discipline) and the
// report instruction is the only reason it answers in a shape the orchestrator can
// read (§4.1). While one transport existed, assembling that inline was fine. A second
// one is where it drifts — and a drifted report instruction does not fail loudly, it
// produces a worker that did the work and threw it away, which is exactly what
// defects 20 and 24 cost. So the assembly is one pure function, and this file pins
// both that the CLI transport uses it and that its parts are all present.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aCodeTask, anAgentSpec } from "../testing/fixtures.js";
import { type CliOutcome } from "./claudeCode.js";
import { workerPrompt } from "./prompt.js";
import { createCliTransport } from "./transport.js";

/** Records what the worker was told, and answers with a canned message. */
function fakeRunners() {
  const seen: { prompt: string; cwd: string; cli: "claude" | "codex" }[] = [];
  const make =
    (cli: "claude" | "codex") =>
    async (prompt: string, cwd: string): Promise<CliOutcome> => {
      seen.push({ prompt, cwd, cli });
      return { text: "{}" };
    };
  return { runners: { claude: make("claude"), codex: make("codex") }, seen };
}

describe("the worker prompt", () => {
  test("carries the system prompt, the goal, and nothing about the mission", () => {
    const task = aCodeTask({
      goal: "Add a /health endpoint",
      agentSpec: anAgentSpec({ systemPrompt: "You are a careful endpoint author." }),
    });

    const prompt = workerPrompt(task);

    assert.match(prompt, /You are a careful endpoint author\./);
    assert.match(prompt, /Add a \/health endpoint/);
    // The worker has no view of the mission, the ledger, or the other tasks.
    assert.doesNotMatch(prompt, /m1/);
  });

  // Rendered from `workerReportSchema` rather than described, so what the worker is
  // asked for cannot drift from the parser that will reject the answer (defect 20).
  test("renders the report schema rather than describing it", () => {
    const prompt = workerPrompt(aCodeTask());

    assert.match(prompt, /"criteriaTouched"/);
    assert.match(prompt, /"deadEnds"/);
    assert.match(prompt, /"outcome"/);
    assert.match(prompt, /never sees your transcript/);
  });

  test("puts the report instruction last, where a closing instruction is read", () => {
    const prompt = workerPrompt(aCodeTask({ goal: "Add a /health endpoint" }));

    assert.ok(prompt.indexOf("Add a /health endpoint") < prompt.indexOf("## How to finish"));
  });

  // The point of the extraction: the ACP transport (Phase 7) and the CLI transport
  // send the same bytes, or the seam has quietly become two contracts.
  test("is byte-identical to what the cli transport actually sends", async () => {
    const { runners, seen } = fakeRunners();
    const task = aCodeTask();

    await createCliTransport({ runners })({ task, cwd: "/worktree" });

    assert.equal(seen.at(-1)!.prompt, workerPrompt(task));
  });

  test("the cli transport sends it to the CLI the spec names", async () => {
    const { runners, seen } = fakeRunners();
    const task = aCodeTask({ agentSpec: anAgentSpec({ transport: { id: "cli", target: "codex" } }) });

    await createCliTransport({ runners })({ task, cwd: "/worktree" });

    assert.equal(seen.at(-1)!.cli, "codex");
  });

  // P2. A worker that may not write into the checkout (defect 41) and may still be
  // obliged to leave a file behind (defect 27) has exactly one legal location, and no
  // way to know it unless the runtime says so.
  describe("where the output goes", () => {
    const dir = "/state/missions/m1/artifacts/t1";

    test("names the absolute directory, because the worker resolves against another one", () => {
      const prompt = workerPrompt(aCodeTask(), dir);

      assert.ok(prompt.includes(dir));
      assert.match(prompt, /Report every file you write as an artifact/);
    });

    test("names the declared file when the spec declared one", () => {
      const task = aCodeTask({ agentSpec: anAgentSpec({ outputPath: "report.md" }) });

      assert.ok(workerPrompt(task, dir).includes(`${dir}/report.md`));
    });

    // Absent means the directory itself, and saying nothing beats inventing a path.
    test("says nothing about a directory when the dispatch had none", () => {
      assert.equal(workerPrompt(aCodeTask()).includes("Where your output goes"), false);
    });

    // The report instruction is the last thing a worker reads for a reason (§4.1);
    // an output section wedged after it would bury the contract that matters most.
    test("comes before the report instruction", () => {
      const prompt = workerPrompt(aCodeTask(), dir);

      assert.ok(prompt.indexOf(dir) < prompt.indexOf("## How to finish"));
    });

    test("the cli transport passes the directory through", async () => {
      const { runners, seen } = fakeRunners();
      const task = aCodeTask();

      await createCliTransport({ runners })({ task, cwd: "/worktree", artifactDir: dir });

      assert.equal(seen.at(-1)!.prompt, workerPrompt(task, dir));
    });
  });

  // PLAN-NEXT 5.2. Each worker sees one task and never the mission around it, so the
  // design note is the only place the shape of the whole change is written down — and it
  // arrives as a path the runtime decided, never as text the spec invented.
  describe("the design note", () => {
    const note = "/state/missions/m1/artifacts/design.md";

    test("a code task is told where the design is", () => {
      const prompt = workerPrompt(aCodeTask(), undefined, note);

      assert.ok(prompt.includes(note));
      assert.match(prompt, /Read it before you start/);
    });

    // A review or research worker is not writing against the design, so a path it would
    // open and read costs the mission a file read to inform work it does not do (§4).
    test("a non-code task is not", () => {
      const task = aCodeTask({ worker: "review" });

      assert.equal(workerPrompt(task, undefined, note).includes(note), false);
    });

    // A quick mission has no architect, so there is no note and nothing is said about
    // one — the same silence an absent artifact directory gets.
    test("a mission without one says nothing about a design", () => {
      assert.equal(workerPrompt(aCodeTask()).includes("The design this fits into"), false);
    });

    test("the cli transport passes it through", async () => {
      const { runners, seen } = fakeRunners();
      const task = aCodeTask();

      await createCliTransport({ runners })({ task, cwd: "/worktree", designNote: note });

      assert.equal(seen.at(-1)!.prompt, workerPrompt(task, undefined, note));
    });
  });
});
