// The failure under test is defect 42: a worker that inherits every variable the
// orchestrator was started with. So these are written from the leak's side — the
// interesting case is always a secret sitting in the parent environment that nobody
// asked for, and the assertion is that it is *not there*, not that it was removed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildWorkerEnv, PROCESS_BASELINE_VARS } from "./childEnv.js";

const parent: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  AWS_SECRET_ACCESS_KEY: "leak-me",
  DATABASE_URL: "postgres://leak",
  XERO_TOKEN: "granted",
};

describe("buildWorkerEnv", () => {
  test("constructs from nothing: a parent variable nobody named never appears", () => {
    const env = buildWorkerEnv({ parent, transportVars: ["PATH", "HOME"] });

    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/someone" });
    assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
    assert.equal("DATABASE_URL" in env, false);
  });

  test("carries a variable the envelope granted this task", () => {
    const env = buildWorkerEnv({
      parent,
      transportVars: ["PATH"],
      allowed: ["XERO_TOKEN"],
    });

    assert.deepEqual(env, { PATH: "/usr/bin", XERO_TOKEN: "granted" });
  });

  // A CLI that checks `if (VAR)` cannot tell an empty string from a missing one, and a
  // CLI that checks `"VAR" in env` takes the wrong branch with no error at all.
  test("an allowed name the parent does not have stays absent rather than becoming empty", () => {
    const env = buildWorkerEnv({ parent, allowed: ["NEVER_SET"] });

    assert.equal("NEVER_SET" in env, false);
    assert.deepEqual(env, {});
  });

  // `child_process` reads a present-and-undefined key as "remove this variable", so
  // copying one across would carry a removal into an environment with nothing to remove.
  test("an undefined value in the parent is a hole, not an entry", () => {
    const env = buildWorkerEnv({
      parent: { PATH: "/usr/bin", CLAUDECODE: undefined },
      transportVars: ["PATH", "CLAUDECODE"],
    });

    assert.equal("CLAUDECODE" in env, false);
  });

  test("literals are set outright rather than passed through", () => {
    const env = buildWorkerEnv({
      parent,
      transportVars: ["PATH"],
      literals: { FAKE_SCENARIO: "happy" },
    });

    assert.equal(env["FAKE_SCENARIO"], "happy");
    assert.equal(env["PATH"], "/usr/bin");
  });

  test("returns a fresh record and never mutates the parent", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const first = buildWorkerEnv({ parent: source, transportVars: ["PATH"] });
    first["PATH"] = "/tampered";

    assert.equal(source["PATH"], "/usr/bin");
    assert.equal(buildWorkerEnv({ parent: source, transportVars: ["PATH"] })["PATH"], "/usr/bin");
  });

  test("an empty request produces an empty environment, not an inherited one", () => {
    assert.deepEqual(buildWorkerEnv({ parent }), {});
  });

  // The baseline is what makes a worker able to start at all; the two that every
  // transport on every platform needs are worth pinning against a careless trim.
  test("the process baseline carries PATH and HOME", () => {
    assert.equal(PROCESS_BASELINE_VARS.includes("PATH"), true);
    assert.equal(PROCESS_BASELINE_VARS.includes("HOME"), true);
  });

  // The spike's finding, now expressed as an absence: an orchestrator running under
  // Claude Code exports CLAUDECODE=1, and an adapter that inherits it believes it is
  // nested inside a session. Under construction it is simply never named.
  test("CLAUDECODE is not in the baseline", () => {
    assert.equal(PROCESS_BASELINE_VARS.includes("CLAUDECODE"), false);
  });
});
