// Defect 6: `command.split(" ")` broke on the first quoted argument, and the
// verification then failed for a reason that had nothing to do with the work.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { needsShell, parseCommand } from "./command.js";

describe("parseCommand", () => {
  test("splits a plain command", () => {
    assert.deepEqual(parseCommand("npm test"), { cmd: "npm", args: ["test"] });
  });

  test("keeps a double-quoted argument whole", () => {
    assert.deepEqual(parseCommand('npm test -- --grep "health endpoint"'), {
      cmd: "npm",
      args: ["test", "--", "--grep", "health endpoint"],
    });
  });

  test("keeps a single-quoted argument whole", () => {
    assert.deepEqual(parseCommand("pytest -k 'not slow'"), {
      cmd: "pytest",
      args: ["-k", "not slow"],
    });
  });

  test("handles an escaped space outside quotes", () => {
    assert.deepEqual(parseCommand("make my\\ target"), { cmd: "make", args: ["my target"] });
  });

  test("does not treat a backslash inside single quotes as an escape", () => {
    assert.deepEqual(parseCommand("grep 'a\\b'"), { cmd: "grep", args: ["a\\b"] });
  });

  test("collapses runs of whitespace", () => {
    assert.deepEqual(parseCommand("  npm\t  run   build "), {
      cmd: "npm",
      args: ["run", "build"],
    });
  });

  // An empty argument is meaningful: `foo ""` passes one empty string, not nothing.
  test("preserves an explicitly empty argument", () => {
    assert.deepEqual(parseCommand('foo "" bar'), { cmd: "foo", args: ["", "bar"] });
  });

  test("rejects an unbalanced quote instead of guessing", () => {
    assert.throws(() => parseCommand('npm test --grep "unclosed'), /Unbalanced/);
  });

  test("rejects an empty command", () => {
    assert.throws(() => parseCommand("   "), /Empty command/);
  });
});

describe("needsShell", () => {
  // Running `npm test | tee log` as a program with a literal `|` argument fails in a
  // way that reads like a broken test suite. Better to say so.
  test("detects a command that only means something in a shell", () => {
    assert.equal(needsShell("npm test | tee log"), true);
    assert.equal(needsShell("cd x && npm test"), true);
    assert.equal(needsShell("echo $HOME"), true);
  });

  test("leaves an ordinary command alone", () => {
    assert.equal(needsShell('npm test -- --grep "health endpoint"'), false);
  });

  // Defect 34: a raw regex over the whole string read the `=>` inside a quoted
  // `node -e` script as a redirect, and every criterion check written as a JS
  // one-liner was refused however runnable it was. Found on proving run 4, after
  // three runs of prompt fixes aimed at what was actually a false positive.
  test("metacharacters inside quotes do not need a shell", () => {
    assert.equal(needsShell('node -e "import(\'./x.js\').then(m => m.clamp(1))"'), false);
    assert.equal(needsShell("grep -E 'a|b' file.txt"), false);
    assert.equal(needsShell('node -e "const f = (a) => { return a && a.b; }"'), false);
  });

  test("metacharacters outside quotes still do", () => {
    assert.equal(needsShell('node -e "ok" > out.txt'), true);
    assert.equal(needsShell("node --test $(ls test)"), true);
  });

  test("an unbalanced quote is a shell question answered loudly elsewhere", () => {
    assert.equal(needsShell('npm test "unclosed'), true);
  });
});
