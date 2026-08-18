// The failure mode under test: a task dispatched to the wrong runtime, or to none.
//
// `createCliTransport` used to answer for every transport id by refusing the ones it
// was not — a guard that was correct while one transport existed and becomes the
// wrong place for the decision the moment a second does. Which runtime a task uses is
// a property of its spec (§7), so something has to read `transport.id` and pick. That
// is this file, and the reason it is separate is that the answer for an id nobody
// built has to be one message naming the id, what is available, and the fix — not a
// silent fall-through to whichever transport happened to be wired at the root.
//
// It throws rather than returning a result because `dispatch` classifies a throw
// between `running` and the report as a `transport` failure (§9.4), which is exactly
// what an unbuilt transport is: the worker delivered nothing, and a typed retry then a
// replan is the right response.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type WorkerRun, type WorkerTransport } from "../loop/dispatch.js";
import { aCodeTask, anAgentSpec } from "../testing/fixtures.js";
import { routeTransport } from "./router.js";

const answering = (raw: string): WorkerTransport => {
  return async (): Promise<WorkerRun> => ({ raw, elapsedMs: 1 });
};

const taskOn = (id: "cli" | "acp" | "agent-sdk" | "chrome-mcp") =>
  aCodeTask({ agentSpec: anAgentSpec({ transport: { id } }) });

describe("transport routing", () => {
  test("sends a task to the transport its spec names", async () => {
    const route = routeTransport({ cli: answering("from cli"), acp: answering("from acp") });

    const run = await route({ task: taskOn("acp"), cwd: "/worktree" });

    assert.equal(run.raw, "from acp");
  });

  test("passes the cwd and the abort signal straight through", async () => {
    const seen: { cwd: string; signal?: AbortSignal }[] = [];
    const recording: WorkerTransport = async ({ cwd, signal }) => {
      seen.push({ cwd, ...(signal ? { signal } : {}) });
      return { raw: "ok", elapsedMs: 1 };
    };
    const route = routeTransport({ cli: recording });
    const controller = new AbortController();

    await route({ task: taskOn("cli"), cwd: "/worktree", signal: controller.signal });

    assert.equal(seen[0]!.cwd, "/worktree");
    assert.equal(seen[0]!.signal, controller.signal);
  });

  // §2a rule 5: the message carries the fix. An id nobody built is a planning problem,
  // and the planner needs to be told which ids exist to plan differently.
  test("an unbuilt transport names the id, the built ones, and the fix", async () => {
    const route = routeTransport({ cli: answering("from cli") });

    await assert.rejects(
      () => route({ task: taskOn("chrome-mcp"), cwd: "/worktree" }),
      (error: Error) => {
        assert.match(error.message, /chrome-mcp/);
        assert.match(error.message, /cli/);
        assert.match(error.message, /Plan this task with/);
        return true;
      },
    );
  });

  // A router with nothing wired is a composition-root mistake, and it must say so
  // rather than reporting every task as an unbuilt transport.
  test("refuses to be built with no transports at all", () => {
    assert.throws(() => routeTransport({}), /at least one transport/);
  });
});
