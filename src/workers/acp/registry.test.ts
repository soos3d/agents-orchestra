// The failure mode under test: a launch command that drifts from what the spike actually
// spawned, and is only found out by a mission that dies at dispatch.
//
// Two of these assertions look pedantic and are not. The version pin is exact because a
// floating tag is what the OpenClaw spike caught pointing at a 0.0.0 stub, and the
// `CLAUDECODE` entry has to survive as a *present key with an undefined value* — that is
// the shape `child_process` strips from the child's environment, and a test asserting only
// `env.CLAUDECODE === undefined` would pass just as happily if the key were dropped.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acpAgentCommand, acpTargets } from "./registry.js";

describe("the acp agent registry", () => {
  test("claude launches the pinned claude-code-acp adapter", () => {
    const launch = acpAgentCommand("claude");

    assert.ok(launch);
    assert.equal(launch.command, "npx");
    assert.deepEqual(launch.args, ["-y", "@zed-industries/claude-code-acp@0.16.2"]);
  });

  test("codex launches the pinned codex-acp adapter", () => {
    const launch = acpAgentCommand("codex");

    assert.ok(launch);
    assert.equal(launch.command, "npx");
    assert.deepEqual(launch.args, ["-y", "@zed-industries/codex-acp@0.16.0"]);
  });

  // A range would resolve to whatever is published on the day a mission runs, against an
  // adapter whose frames `protocol.ts` is written from captures of (§0's dist-tag lesson).
  test("every pinned version is exact, never a range", () => {
    for (const target of acpTargets()) {
      const launch = acpAgentCommand(target);
      const spec = launch?.args.find((arg) => arg.includes("@zed-industries/"));

      assert.ok(spec, `${target} does not name a package to pin`);
      assert.match(spec, /@\d+\.\d+\.\d+$/, `${target} is not pinned to an exact version`);
    }
  });

  // The spike's finding: claude-code-acp inherits `CLAUDECODE=1` when the mission itself
  // runs under Claude Code, and the adapter then behaves as though it were nested.
  test("claude's env strips CLAUDECODE rather than setting it", () => {
    const launch = acpAgentCommand("claude");

    assert.ok(launch?.env);
    assert.ok("CLAUDECODE" in launch.env, "the key must be present for spawn to strip it");
    assert.equal(launch.env["CLAUDECODE"], undefined);
  });

  // Not built rather than not chosen: the transport turns `undefined` into an error
  // naming the target and the ones that exist, which is a planning problem (§9.4).
  test("opencode is not registered until its ACP invocation has been probed", () => {
    assert.equal(acpAgentCommand("opencode"), undefined);
  });

  test("an unknown target resolves to nothing", () => {
    assert.equal(acpAgentCommand("gemini"), undefined);
    assert.equal(acpAgentCommand(""), undefined);
  });

  test("the target list is what an error message can offer a planner", () => {
    assert.deepEqual([...acpTargets()].sort(), ["claude", "codex"]);
  });
});
