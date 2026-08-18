// The failure this exists to prevent: a mission that runs its whole reset budget,
// does every task correctly, and can never legitimately say it is finished — because
// the contract it was given cannot be evaluated by anything.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { writeOutcomeSpec } from "./outcomeSpec.js";

describe("writeOutcomeSpec", () => {
  test("accepts a criterion with a command check", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "GET /health returns 200", check: { kind: "command", command: "npm test" } },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]?.id, "c1");
  });

  // A live mission wrote `test -f index.html && grep -q '<script'` as a criterion, twice,
  // with the prompt already forbidding `&&` in a check. It passed this validation, was
  // signed off, froze into the contract, and would have been refused by `needsShell` at
  // verification time — every round, with the work already done and correct. That is the
  // failure this file exists to prevent, one field deeper than "has a check": a check the
  // runtime will refuse is a check that never produces an answer. Refusing it here makes
  // it a planning problem the author is sent back to fix, which is what `inspect()` does
  // for an invented model id.
  test("rejects a command check that needs a shell, which verification would refuse", () => {
    const result = writeOutcomeSpec([
      {
        id: "c1",
        statement: "the page exists and has an inline script",
        check: { kind: "command", command: "test -f index.html && grep -q '<script' index.html" },
      },
    ]);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.rejected[0]!.reason : "", /shell|&&/);
  });

  // The quoting rules are `runtime/command.ts`'s, not a second opinion about them: a `&&`
  // inside quotes is an argument, and refusing it here would fail correct work — defect 34
  // in the validator instead of in the scanner.
  test("accepts a command whose shell operator is inside quotes, because that is an argument", () => {
    const result = writeOutcomeSpec([
      {
        id: "c1",
        statement: "the README documents the && idiom",
        check: { kind: "command", command: "grep -q 'a && b' README.md" },
      },
    ]);

    assert.equal(result.ok, true);
  });

  test("accepts a criterion checked by a judge, which is how non-code work closes", () => {
    const result = writeOutcomeSpec([
      {
        id: "c1",
        statement: "Every June Xero invoice is matched to a Ramp transaction",
        check: { kind: "judge", rubric: "counts equal, no orphans on either side" },
      },
    ]);

    assert.equal(result.ok, true);
  });

  test("rejects a criterion carrying no check at all", () => {
    const result = writeOutcomeSpec([{ id: "c1", statement: "the checkout flow is less janky" }]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.rejected[0]?.criterion.includes("janky"));
    assert.ok(!result.ok && /check/.test(result.rejected[0]?.reason ?? ""));
  });

  // The vague-criterion case, in the only form code can decide: a check that will
  // never produce an answer.
  test("rejects a check of kind none", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "the code feels cleaner", check: { kind: "none", reason: "subjective" } },
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && /never be evaluated/.test(result.rejected[0]?.reason ?? ""));
  });

  test("rejects an empty spec, which would finish the moment it started", () => {
    const result = writeOutcomeSpec([]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && /nothing to verify/.test(result.rejected[0]?.reason ?? ""));
  });

  test("rejects duplicate ids, which would make satisfies ambiguous", () => {
    const check = { kind: "command", command: "npm test" };
    const result = writeOutcomeSpec([
      { id: "c1", statement: "one", check },
      { id: "c1", statement: "two", check },
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.rejected[0]?.reason.includes("'c1'"));
  });

  test("reports every bad criterion at once, not just the first", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "no check here" },
      { id: "c2", statement: "nor here" },
    ]);

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.rejected.length, 2);
  });

  test("rejects the whole spec when one criterion is bad", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "fine", check: { kind: "command", command: "npm test" } },
      { id: "c2", statement: "not fine" },
    ]);

    assert.equal(result.ok, false);
  });
});

// PLAN-NEXT 6.3's "opt-in per mission, never default", as a property of the code. A
// deepsec scan is an AI agent with shell access and hundreds of dollars of billing on a
// large repository, so the criterion that names one is refused before anything runs
// unless a human granted it and the machine answered for it.
describe("writeOutcomeSpec and specialist scanners", () => {
  const scanned = {
    id: "c1",
    statement: "the changed files carry no high-severity vulnerability",
    check: { kind: "scanner", scanner: "deepsec" },
  };

  test("refuses a scanner nobody granted, which is every mission by default", () => {
    const result = writeOutcomeSpec([scanned]);

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /no scanner is available/);
    // Every message in this file names the fix.
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /command to run or a rubric/);
  });

  test("accepts it when the mission was granted that scanner", () => {
    const result = writeOutcomeSpec([scanned], ["deepsec"]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]!.check.kind, "scanner");
  });

  test("a granted scanner does not grant a different one", () => {
    const result = writeOutcomeSpec([scanned], ["something-else"]);

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /only something-else is available/);
  });

  // The threshold is the criterion's to set and the schema's to constrain — an invented
  // rung would be a filter that matches nothing.
  test("an invented severity is refused by the schema", () => {
    const result = writeOutcomeSpec(
      [{ ...scanned, check: { kind: "scanner", scanner: "deepsec", minSeverity: "SPICY" } }],
      ["deepsec"],
    );

    assert.equal(result.ok, false);
  });
});

// PLAN-NEXT 7.2's validation half. Mock-first is a prompt convention and needs no new
// machinery — but a convention whose output this gate refused would be a rule the system
// teaches and then punishes, which is the P2 collision (defects 27, 41, 43) in its fourth
// shape. This pins that a mocked build is judgeable exactly like anything else: the
// criterion carries a check that runs, so it is accepted, and being *about* mocks is not
// something this gate has an opinion on.
describe("a mock-first criterion", () => {
  test("is accepted when it carries a command that runs against the fake", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked",
        statement: "The payment client runs green against the in-repo fake",
        check: { kind: "command", command: "node --test test/payments.test.js" },
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]!.statement.includes("fake"), true);
  });

  test("is accepted when a judge grades the mocked build's artifacts", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked-judge",
        statement: "Every external dependency is behind an interface with a mock",
        check: {
          kind: "judge",
          rubric: "src/payments/ defines an interface and a fake implementing it",
        },
      },
    ]);

    assert.equal(result.ok, true);
  });

  // The other half of the pair, and the one that keeps the convention honest: naming
  // mocks does not buy a criterion out of carrying a check.
  test("is refused like any other when it has no check", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked-none",
        statement: "Runs against mocks",
        check: { kind: "none", reason: "we will look at it" },
      },
    ]);

    assert.equal(result.ok, false);
  });
});

// The defect the 2026-08-18 calculator run recorded in production: `criterion_checked`
// with `met: true` and `checkOutput: "exit 0\nfalse"`. The criteria had been authored as
// `node -e "console.log(cond ? 'true' : 'false')"`, which exits 0 whatever it decides,
// and `runCommand` reads the exit code and never the output. Four of that mission's six
// command criteria were in that state. A criterion that cannot fail is not a gate — it is
// `kind: 'none'` wearing a command, which is what this file already refuses.
//
// The gate cannot execute the check, so it cannot know the exit code. What it can read is
// the shape: a `node -e`/`node -p` body that prints a true/false verdict and carries
// nothing that could make the process exit non-zero. Everything else is accepted, because
// a false refusal here fails correct work (defects 34, 37, 38, 44 — four scanners over
// model output, all of them failing on work that was right).
describe("a command check that prints its verdict instead of exiting on it", () => {
  const refused = (command: string) => {
    const result = writeOutcomeSpec([{ id: "c1", statement: "s", check: { kind: "command", command } }]);
    return result.ok === false ? result.rejected[0]!.reason : undefined;
  };

  test("is refused, in the exact shape the run produced", () => {
    const reason = refused(`node -e "console.log(2 + 2 === 4 ? 'true' : 'false')"`);

    assert.match(reason ?? "", /exit code/);
    // Every message in this file names the fix.
    assert.match(reason ?? "", /process\.exit/);
  });

  test("is refused when the verdict is printed after real work, which is how it is written", () => {
    const reason = refused(
      `node -e "const s = require('fs').readFileSync('index.html', 'utf8'); console.log(s.includes('<script') ? 'true' : 'false')"`,
    );

    assert.match(reason ?? "", /exit code/);
  });

  test("is refused for node -p, which prints its expression and exits 0 all the same", () => {
    assert.match(refused(`node -p "ok ? 'true' : 'false'"`) ?? "", /exit code/);
  });

  test("is refused for --eval=, because the flag's spelling is not the defect", () => {
    assert.match(refused(`node --eval="console.log(true)"`) ?? "", /exit code/);
  });

  // The other half, and the one that matters more: everything below can fail, so nothing
  // below may be refused.
  test("accepts the check the prompts now ask for", () => {
    assert.equal(refused(`node -e "process.exit(2 + 2 === 4 ? 0 : 1)"`), undefined);
  });

  test("accepts a check that prints its verdict and then exits on it", () => {
    assert.equal(
      refused(`node -e "const ok = 2 + 2 === 4; console.log(ok ? 'true' : 'false'); process.exit(ok ? 0 : 1)"`),
      undefined,
    );
  });

  test("accepts a check that throws or asserts, which is how a node check usually fails", () => {
    assert.equal(refused(`node -e "require('assert').equal(add(2, 2), 4)"`), undefined);
    assert.equal(refused(`node -e "if (!ok) throw new Error('not ok')"`), undefined);
  });

  test("accepts a test runner, which decides its own exit code", () => {
    assert.equal(refused(`node --test test/calculator.test.js`), undefined);
    assert.equal(refused(`npm test`), undefined);
  });

  // The scanner has to know what it is inside of — the standing trap. A `true` inside a
  // string the check is searching *for* is data, not a verdict, and a program that is not
  // node is not this shape at all.
  test("accepts a non-node command that merely mentions true", () => {
    assert.equal(refused(`grep -q 'return true' src/index.js`), undefined);
  });

  test("accepts a printed message that is not a true/false verdict", () => {
    assert.equal(refused(`node -e "console.log('all checks passed')"`), undefined);
  });
});
