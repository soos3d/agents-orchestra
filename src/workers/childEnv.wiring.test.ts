// The failure mode under test: `buildWorkerEnv` correct, and nothing calling it.
//
// This repo has paid three times for the same shape of bug — `requestExtension`, `owns`
// and `reformat` were each built, tested, and reachable only through a parameter no
// entry point passed. `childEnv.test.ts` proves the construction rule; it says nothing
// about whether a dispatched worker's process gets a constructed environment. So this
// file drives the real transport factories, with a parent environment holding a secret
// nobody granted, and asserts on what actually reaches the spawn call.
//
// It is a separate file from `childEnv.test.ts` deliberately: one is a pure function's
// contract and the other is the wiring, and a green pure-function test being read as
// evidence for the wiring is the whole defect being guarded against.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aCodeTask, anAgentSpec } from "../testing/fixtures.js";
import { type CliOutcome } from "./claudeCode.js";
import { createCliTransport } from "./transport.js";

/** A parent environment shaped like a developer's: the tools' own variables, and three
 *  secrets that have nothing to do with any mission. */
const parentEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  ANTHROPIC_API_KEY: "sk-transport",
  CLAUDECODE: "1",
  AWS_SECRET_ACCESS_KEY: "leak-me",
  DATABASE_URL: "postgres://leak",
  XERO_TOKEN: "granted-by-envelope",
};

/** Records the environment each worker was actually given. */
function fakeRunners() {
  const seen: { cli: "claude" | "codex"; env?: NodeJS.ProcessEnv }[] = [];
  const make =
    (cli: "claude" | "codex") =>
    async (_prompt: string, _cwd: string, options: { env?: NodeJS.ProcessEnv }): Promise<CliOutcome> => {
      seen.push({ cli, ...(options.env ? { env: options.env } : {}) });
      return { text: "{}" };
    };
  return { runners: { claude: make("claude"), codex: make("codex") }, seen };
}

describe("what a dispatched worker's process can actually see", () => {
  test("the cli transport constructs the child environment rather than inheriting it", async () => {
    const { runners, seen } = fakeRunners();

    await createCliTransport({ runners, parentEnv })({ task: aCodeTask(), cwd: "/worktree" });

    const env = seen.at(-1)!.env;
    assert.ok(env, "the transport passed no environment, so the child inherits everything");
    assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
    assert.equal("DATABASE_URL" in env, false);
    assert.equal("XERO_TOKEN" in env, false);
    // And it is still a working process with credentials it can authenticate on.
    assert.equal(env["PATH"], "/usr/bin");
    assert.equal(env["HOME"], "/Users/someone");
    assert.equal(env["ANTHROPIC_API_KEY"], "sk-transport");
  });

  // The spike's finding, at the layer that decides it: an orchestrator running under
  // Claude Code exports CLAUDECODE=1 and a child that inherits it believes it is nested.
  test("CLAUDECODE does not reach a cli worker even when the orchestrator has it", async () => {
    const { runners, seen } = fakeRunners();

    await createCliTransport({ runners, parentEnv })({ task: aCodeTask(), cwd: "/worktree" });

    assert.equal("CLAUDECODE" in seen.at(-1)!.env!, false);
  });

  test("a variable the spec was granted is carried through to the worker", async () => {
    const { runners, seen } = fakeRunners();
    const task = aCodeTask({ agentSpec: anAgentSpec({ env: ["XERO_TOKEN"] }) });

    await createCliTransport({ runners, parentEnv })({ task, cwd: "/worktree" });

    assert.equal(seen.at(-1)!.env!["XERO_TOKEN"], "granted-by-envelope");
    // The grant is for one name, not for the neighbourhood it sits in.
    assert.equal("AWS_SECRET_ACCESS_KEY" in seen.at(-1)!.env!, false);
  });

  // The credential a `claude` worker needs is not the one a `codex` worker needs, and
  // handing every worker both is the leak one adapter wide.
  test("each target gets its own transport credentials and not the other's", async () => {
    const { runners, seen } = fakeRunners();
    const task = aCodeTask({
      agentSpec: anAgentSpec({ transport: { id: "cli", target: "codex" } }),
    });

    await createCliTransport({
      runners,
      parentEnv: { ...parentEnv, OPENAI_API_KEY: "sk-codex" },
    })({ task, cwd: "/worktree" });

    assert.equal(seen.at(-1)!.env!["OPENAI_API_KEY"], "sk-codex");
    assert.equal("ANTHROPIC_API_KEY" in seen.at(-1)!.env!, false);
  });

  // Production wires no `parentEnv`, so the default is the behaviour every real mission
  // gets: this process's environment as the *source*, never as the child's.
  test("the default source is this process, and it is still constructed", async () => {
    const { runners, seen } = fakeRunners();
    process.env["ORCHESTRA_CHILD_ENV_PROBE"] = "leak-me";

    try {
      await createCliTransport({ runners })({ task: aCodeTask(), cwd: "/worktree" });
    } finally {
      delete process.env["ORCHESTRA_CHILD_ENV_PROBE"];
    }

    const env = seen.at(-1)!.env;
    assert.ok(env);
    assert.equal("ORCHESTRA_CHILD_ENV_PROBE" in env, false);
    assert.equal(env["PATH"], process.env["PATH"]);
  });
});
