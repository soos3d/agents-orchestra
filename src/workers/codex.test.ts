// Defect 13: the flags a worker CLI is actually spawned with drift, and nothing in a
// green suite notices — the same blind spot `agentCalls.ts` has, with a subprocess in
// place of a prompt. `codex exec --full-auto` warned "deprecated; use `--sandbox
// workspace-write` instead" on codex-cli 0.146.1, verified on this machine 2026-08-10,
// and the argv is a pure function precisely so the next drift is catchable for free.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codexArgs } from "./codex.js";

describe("codexArgs", () => {
  const args = codexArgs("do the thing", "gpt-5", "/tmp/out.txt");

  test("sandboxes the workspace rather than passing the deprecated --full-auto", () => {
    assert.equal(args.includes("--full-auto"), false);
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  });

  test("never reaches for the flag that removes the sandbox entirely", () => {
    // §11's argument one process out: a worker that can be talked into anything is not
    // bounded by a lease it can delete.
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  });

  test("keeps the prompt, the model, and the last-message file", () => {
    assert.deepEqual(args.slice(0, 2), ["exec", "do the thing"]);
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5");
    assert.equal(args[args.indexOf("--output-last-message") + 1], "/tmp/out.txt");
  });

  test("still runs outside a git repo, which a research worktree may not be", () => {
    assert.equal(args.includes("--skip-git-repo-check"), true);
  });
});
