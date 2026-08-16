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

// Defect 44: the tokenizer deleted backslashes inside double quotes, so the argument the
// program received was not the one the command said — silently, and only for commands
// that are correct.
//
// It cost a real mission three criteria. The check carried `r'-?\d+\.?\d*'` inside a
// `python3 -c "…"` argument; `r'-?d+.?d*'` ran, matched nothing, and the assertion failed
// while quoting the correct output of a correct script. Pasted into a shell it passed.
//
// POSIX is specific and unintuitive: inside double quotes a backslash is literal unless
// the next character is one of $ ` " \ or a newline.
describe("backslashes inside double quotes", () => {
  test("keeps a backslash that a shell would keep", () => {
    const parsed = parseCommand(String.raw`python3 -c "re.findall(r'-?\d+\.?\d*', s)"`);

    assert.deepEqual(parsed.args, ["-c", String.raw`re.findall(r'-?\d+\.?\d*', s)`]);
  });

  test("still consumes one a shell would consume", () => {
    // The POSIX cases, each of which a shell does act on inside double quotes. Written
    // with ordinary quotes rather than String.raw because one of them is a backtick,
    // which cannot appear in a template literal.
    assert.deepEqual(parseCommand('p "a\\$b"').args, ["a$b"]);
    assert.deepEqual(parseCommand('p "a\\`b"').args, ["a`b"]);
    assert.deepEqual(parseCommand('p "a\\"b"').args, ['a"b']);
    assert.deepEqual(parseCommand('p "a\\\\b"').args, ["a\\b"]);
  });

  test("single quotes keep every backslash, as they always did", () => {
    assert.deepEqual(parseCommand(String.raw`p 'a\db'`).args, [String.raw`a\db`]);
  });

  test("an unquoted backslash still escapes anything, as it always did", () => {
    assert.deepEqual(parseCommand(String.raw`p a\ b`).args, ["a b"]);
  });

  test("a regex-bearing check is not mistaken for something needing a shell", () => {
    // The command that failed, end to end: it has to tokenize *and* be allowed to run.
    const command = String.raw`python3 -c "import re;assert re.findall(r'-?\d+\.?\d*','5.0')"`;

    assert.equal(needsShell(command), false);
    assert.equal(parseCommand(command).args[1], String.raw`import re;assert re.findall(r'-?\d+\.?\d*','5.0')`);
  });

  test("an escaped closing quote leaves the string unterminated, and that is refused", () => {
    // `\"` is one of the five a shell does act on, so this string never closes. Refusing
    // it is correct; the alternative would be inventing a terminator the command lacks.
    assert.throws(() => parseCommand('p "a\\"'), SyntaxError);
  });

  test("a backslash at the very end of the command is kept", () => {
    assert.deepEqual(parseCommand("p a\\").args, ["a\\"]);
  });
});
