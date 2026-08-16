// The failure mode under test: a launch command that drifts from what the spike actually
// spawned, and is only found out by a mission that dies at dispatch.
//
// Two of these assertions look pedantic and are not. The version pin is exact because a
// floating tag is what the OpenClaw spike caught pointing at a 0.0.0 stub; and since
// defect 42 the child environment is built from `inherits` alone, so a launch that
// forgets `PATH` cannot start `npx` at all and one that names `CLAUDECODE` puts the
// spike's nesting bug back — both of those are properties of this table, checked here.
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
  // Only for the launches that download something: `opencode acp` is a subcommand of a
  // binary the human installed, and there is no package spec in it to pin.
  test("every downloaded adapter is pinned exact, never a range", () => {
    const downloaded = acpTargets().filter((target) => acpAgentCommand(target)?.command === "npx");
    assert.ok(downloaded.length > 0);

    for (const target of downloaded) {
      const launch = acpAgentCommand(target);
      const spec = launch?.args.find((arg) => arg.includes("@zed-industries/"));

      assert.ok(spec, `${target} does not name a package to pin`);
      assert.match(spec, /@\d+\.\d+\.\d+$/, `${target} is not pinned to an exact version`);
    }
  });

  // The spike's finding: claude-code-acp inherits `CLAUDECODE=1` when the mission itself
  // runs under Claude Code, and the adapter then behaves as though it were nested. Under
  // a constructed environment the fix is an absence, so that is what is asserted — and
  // for both targets, since the next adapter added is the one that gets it wrong.
  test("no launch inherits CLAUDECODE", () => {
    for (const target of acpTargets()) {
      const launch = acpAgentCommand(target);

      assert.ok(launch);
      assert.equal(launch.inherits?.includes("CLAUDECODE") ?? false, false, target);
      assert.equal("CLAUDECODE" in (launch.env ?? {}), false, target);
    }
  });

  // Nothing is inherited by default any more, so a launch that names nothing is a
  // launch whose `npx` cannot be found and whose CLI cannot find its own credentials.
  test("every launch inherits what it needs to start and authenticate", () => {
    for (const target of acpTargets()) {
      const launch = acpAgentCommand(target);

      assert.ok(launch?.inherits, `${target} inherits nothing and cannot start`);
      assert.ok(launch.inherits.includes("PATH"), `${target} cannot resolve ${launch.command}`);
      assert.ok(launch.inherits.includes("HOME"), `${target} cannot find its credentials`);
    }
  });

  // Registered on 2026-08-16, when `opencode-write-file-approved.jsonl` was captured.
  // The two facts that came with it and are asserted rather than described: the model
  // control is real (`session/set_model` refused an invented id before the prompt), and
  // the permission channel only exists because the launch turns it on — OpenCode's
  // default agent writes with its own tools and asks nobody.
  test("opencode launches its own acp subcommand, honouring the model", () => {
    const launch = acpAgentCommand("opencode");

    assert.equal(launch?.command, "opencode");
    assert.deepEqual(launch?.args, ["acp"]);
    assert.equal(launch?.honoursModel, true);
    assert.match(launch?.env?.["OPENCODE_PERMISSION"] ?? "", /"edit":"ask"/);
  });

  // `acp/claude` is the counter-example the flag exists for: the adapter picks its own
  // model and is never told ours, so a page must not imply a control that does nothing.
  test("a launch that ignores the spec's model does not claim to honour it", () => {
    assert.notEqual(acpAgentCommand("claude")?.honoursModel, true);
    assert.notEqual(acpAgentCommand("codex")?.honoursModel, true);
  });

  test("an unknown target resolves to nothing", () => {
    assert.equal(acpAgentCommand("gemini"), undefined);
    assert.equal(acpAgentCommand(""), undefined);
  });

  test("the target list is what an error message can offer a planner", () => {
    assert.deepEqual([...acpTargets()].sort(), ["claude", "codex", "opencode"]);
  });
});
