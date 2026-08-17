// Task verification asks whether the worker did its job. The two things that would
// quietly break it: a quoted argument split on spaces (defect 6), and a judge handed
// the worker's own summary instead of the artifacts (§3).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { type JudgeInput } from "./calls.js";
import { aCodeTask } from "../testing/fixtures.js";
import { createCriterionChecker, createVerifier, MAX_SCANNED_FILES } from "./verify.js";

// A check command is argv, not a shell line, so a script on disk is how a test gets
// a program that prints and exits non-zero without shell metacharacters.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-verify-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function writeScript(body: string): string {
  const file = path.join(scratch, `check-${fs.readdirSync(scratch).length}.js`);
  fs.writeFileSync(file, body);
  return file;
}

const context = (patch = {}) => ({
  task: aCodeTask(),
  cwd: process.cwd(),
  artifacts: [],
  ...patch,
});

const neverJudges = {
  judge: async (): Promise<never> => {
    throw new Error("a command check must not reach the judge");
  },
};

describe("createVerifier", () => {
  describe("command checks", () => {
    test("passes on exit 0 and reports the code", async () => {
      const verify = createVerifier({ calls: neverJudges });

      const result = await verify({ kind: "command", command: "node -e ''" }, context());

      assert.equal(result.passed, true);
      assert.match(result.output, /exit 0/);
    });

    test("fails on a non-zero exit and keeps the output a fix task needs", async () => {
      const verify = createVerifier({ calls: neverJudges });
      const script = writeScript('console.log("1 test failed"); process.exit(1);');

      const result = await verify({ kind: "command", command: `node ${script}` }, context());

      assert.equal(result.passed, false);
      assert.match(result.output, /1 test failed/);
      assert.match(result.output, /exit 1/);
    });

    // Defect 6: `command.split(" ")` turned this into three arguments, two of them
    // wrong, and the verification then failed for a reason unrelated to the work.
    // Split, printf repeats its format and prints `health.endpoint.` instead.
    test("keeps a quoted argument in one piece", async () => {
      const verify = createVerifier({ calls: neverJudges });

      const result = await verify(
        { kind: "command", command: 'printf "%s." "health endpoint"' },
        context(),
      );

      assert.match(result.output, /health endpoint\./);
    });

    test("a timeout fails rather than hanging the round", async () => {
      const verify = createVerifier({ calls: neverJudges, timeoutMs: 200 });

      const result = await verify({ kind: "command", command: "sleep 60" }, context());

      assert.equal(result.passed, false);
      assert.match(result.output, /timed out/);
    });

    // The tokenizer is not a shell, so a piped command has to say so instead of
    // running as a program called `npm` with a literal `|` argument.
    test("refuses a command that needs a shell, naming the fix", async () => {
      const verify = createVerifier({ calls: neverJudges });

      const result = await verify({ kind: "command", command: "npm test | tee log" }, context());

      assert.equal(result.passed, false);
      assert.match(result.output, /needs a shell/);
      assert.match(result.output, /Wrap it in a script/);
    });
  });

  describe("judge checks", () => {
    test("hands the judge artifacts and never the worker's report", async () => {
      const seen: JudgeInput[] = [];
      const verify = createVerifier({
        calls: {
          judge: async (input) => {
            seen.push(input);
            return {
              met: true,
              evidence: { artifactIds: [], checkOutput: "", reasoning: "the brief answers it", byTask: [] },
            };
          },
        },
      });

      const result = await verify(
        { kind: "judge", rubric: "the brief answers the question" },
        context({
          artifacts: [
            { kind: "document", id: "a1", path: "/tmp/brief.md", summary: "the brief" },
            { kind: "report", id: "a2", text: "a summary the judge must not be graded on" },
          ],
        }),
      );

      assert.equal(result.passed, true);
      assert.deepEqual(seen[0]?.artifactPaths, ["/tmp/brief.md"]);
      assert.equal(seen[0]?.check.rubric, "the brief answers the question");
    });

    // Defect 39, and the reason this test sits next to defect 33's: same bug, other
    // branch. A worker reports what it wrote the way it thinks of it — relative to the
    // directory it was given, which is its worktree. Passed through verbatim, the path
    // resolved against whatever the orchestrator process was sitting in, the judge read
    // "File does not exist", and it failed a correctly-written report. Found on a
    // mission; the suite's fixtures all used absolute paths, which `resolve` leaves
    // alone and which is why nothing here noticed.
    test("a relative document path is resolved against the check's cwd too (defect 39)", async () => {
      const seen: JudgeInput[] = [];
      const verify = createVerifier({
        calls: {
          judge: async (input) => {
            seen.push(input);
            return {
              met: true,
              evidence: { artifactIds: [], checkOutput: "", reasoning: "read it", byTask: [] },
            };
          },
        },
      });

      await verify(
        { kind: "judge", rubric: "the report covers the conventions" },
        context({
          cwd: "/tmp/worktrees/t1",
          artifacts: [
            { kind: "document", id: "a1", path: "CONVENTIONS.md", summary: "recon" },
            { kind: "document", id: "a2", path: "/tmp/elsewhere/absolute.md", summary: "already absolute" },
          ],
        }),
      );

      assert.deepEqual(seen[0]?.artifactPaths, [
        "/tmp/worktrees/t1/CONVENTIONS.md",
        "/tmp/elsewhere/absolute.md",
      ]);
    });

    test("a diff artifact's files reach the judge resolved against the check's cwd (defect 33)", async () => {
      // A code worker's artifact is a diff, which has no path of its own. Dropping it
      // handed the judge an empty list, and a judge with no paths reads the repo —
      // main, where the unmerged work does not exist. The run 3 proving mission
      // failed a correctly-implemented task exactly this way.
      const seen: JudgeInput[] = [];
      const verify = createVerifier({
        calls: {
          judge: async (input) => {
            seen.push(input);
            return {
              met: true,
              evidence: { artifactIds: [], checkOutput: "", reasoning: "read the worktree", byTask: [] },
            };
          },
        },
      });

      await verify(
        { kind: "judge", rubric: "the function exists and matches style" },
        context({
          cwd: "/tmp/worktrees/t1",
          artifacts: [
            { kind: "diff", id: "a1", branch: "orchestra/t1", files: ["src/range.js"], insertions: 9, deletions: 0 },
          ],
        }),
      );

      assert.deepEqual(seen[0]?.artifactPaths, ["/tmp/worktrees/t1/src/range.js"]);
    });

    test("grades the task's own goal, since a task check is not a mission criterion", async () => {
      const seen: JudgeInput[] = [];
      const verify = createVerifier({
        calls: {
          judge: async (input) => {
            seen.push(input);
            return {
              met: false,
              evidence: { artifactIds: [], checkOutput: "", reasoning: "no export found", byTask: [] },
            };
          },
        },
      });

      const result = await verify({ kind: "judge", rubric: "r" }, context());

      assert.equal(result.passed, false);
      assert.equal(result.output, "no export found");
      assert.equal(seen[0]?.criterion.statement, aCodeTask().goal);
    });
  });

  // The only kind that has to argue for itself, and the argument is kept.
  test("a check of kind none passes with its justification", async () => {
    const verify = createVerifier({ calls: neverJudges });

    const result = await verify({ kind: "none", reason: "the artifact is the deliverable" }, context());

    assert.equal(result.passed, true);
    assert.match(result.output, /the artifact is the deliverable/);
  });

  // P2. The log carries a tail, which is enough to see which assertion failed and not
  // enough to re-argue a mission weeks later. Defect 30 is the standing reminder that
  // a string in a log cannot re-open a file that was deleted.
  describe("evidence on disk", () => {
    const evidenceDir = () => fs.mkdtempSync(path.join(scratch, "evidence-"));

    test("a command check's full output is written beside the work", async () => {
      const dir = evidenceDir();
      const verify = createVerifier({ calls: neverJudges });
      const script = writeScript('console.log("2 tests failed"); process.exit(1);');

      await verify({ kind: "command", command: `node ${script}` }, context({ evidenceDir: dir }));

      const kept = fs.readFileSync(path.join(dir, "check.txt"), "utf8");
      assert.match(kept, /2 tests failed/);
      assert.match(kept, /command: node/);
      // §17: a mission's evidence is not world-readable.
      assert.equal(fs.statSync(path.join(dir, "check.txt")).mode & 0o777, 0o600);
    });

    // What the judge opened, recorded next to what it concluded — defects 33, 39 and
    // 40 were each a judge reading the wrong files or none, and every one was
    // diagnosed from a verdict that did not say what it had read.
    test("a judge check records the paths it graded", async () => {
      const dir = evidenceDir();
      const verify = createVerifier({
        calls: {
          judge: async () => ({
            met: true,
            evidence: { artifactIds: [], checkOutput: "", reasoning: "the file says so", byTask: [] },
          }),
        },
      });

      await verify(
        { kind: "judge", rubric: "the report names the policy" },
        context({
          evidenceDir: dir,
          artifacts: [{ kind: "document", id: "a1", path: "/abs/report.md", summary: "s" }],
        }),
      );

      const kept = fs.readFileSync(path.join(dir, "check.txt"), "utf8");
      assert.match(kept, /graded: \/abs\/report\.md/);
      assert.match(kept, /the file says so/);
    });

    test("with no directory the check still runs, and writes nothing", async () => {
      const verify = createVerifier({ calls: neverJudges });

      const result = await verify({ kind: "command", command: "node -e ''" }, context());

      assert.equal(result.passed, true);
    });

    // PLAN-NEXT 7.3. A check runs in a tree a credentialed worker just wrote, and its
    // output goes to three places at once: the `verification_run` event, the failure
    // message a replan reads, and this file. Scrubbed in `runCommand`, so all three get
    // the same string.
    test("a granted secret echoed by a check reaches neither the file nor the result", async () => {
      const dir = evidenceDir();
      const verify = createVerifier({
        calls: neverJudges,
        secrets: [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b5c4d" }],
      });
      const script = writeScript('console.log("used sk_live_9d8f7a6b5c4d");');

      const result = await verify(
        { kind: "command", command: `node ${script}` },
        context({ evidenceDir: dir }),
      );

      const kept = fs.readFileSync(path.join(dir, "check.txt"), "utf8");
      assert.equal(kept.includes("sk_live_9d8f7a6b5c4d"), false, "the key is in the evidence");
      assert.equal(result.output.includes("sk_live_9d8f7a6b5c4d"), false);
      assert.match(kept, /\[redacted:STRIPE_KEY\]/);
      assert.equal(fs.statSync(path.join(dir, "check.txt")).mode & 0o777, 0o600);
    });

    // The other half, and the one a heuristic scrubber would break: output that merely
    // resembles a credential is evidence, and rewriting it fails correct work while
    // quoting text nobody can trace back.
    test("output that only resembles a secret is written exactly as the check produced it", async () => {
      const dir = evidenceDir();
      const verify = createVerifier({
        calls: neverJudges,
        secrets: [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b5c4d" }],
      });
      const script = writeScript('console.log("expected sk_live_0000000000ff");');

      await verify({ kind: "command", command: `node ${script}` }, context({ evidenceDir: dir }));

      assert.match(fs.readFileSync(path.join(dir, "check.txt"), "utf8"), /sk_live_0000000000ff/);
    });

    // Bookkeeping must not decide a mission: a full disk is a missing convenience,
    // not a failed check.
    test("a directory that cannot be written does not fail the check", async () => {
      const verify = createVerifier({ calls: neverJudges });

      const result = await verify(
        { kind: "command", command: "node -e ''" },
        context({ evidenceDir: path.join(scratch, "no-such-file.js", "nested") }),
      );

      assert.equal(result.passed, true);
    });
  });
});

// A criterion's verdict is what a mission terminates on, so where it can be re-read
// matters more here than for a task check (P2). One file per criterion, under the
// mission's own artifact root rather than any one task's: a criterion is about work
// several tasks landed.
describe("createCriterionChecker evidence", () => {
  const criterion = (patch = {}) => ({
    id: "c1",
    statement: "the README documents the NaN policy",
    check: { kind: "command" as const, command: "node -e ''" },
    ...patch,
  });

  test("records where the full verdict was written", async () => {
    const dir = fs.mkdtempSync(path.join(scratch, "criterion-"));
    const check = createCriterionChecker({ calls: neverJudges });

    const result = await check(criterion(), { tasks: [], cwd: process.cwd(), evidenceDir: dir });

    assert.equal(result.met, true);
    assert.equal(result.evidence.checkOutputPath, path.join(dir, "criterion-c1.txt"));
    assert.match(fs.readFileSync(result.evidence.checkOutputPath!, "utf8"), /criterion: c1/);
  });

  test("names the file after the criterion, so several do not overwrite each other", async () => {
    const dir = fs.mkdtempSync(path.join(scratch, "criterion-"));
    const check = createCriterionChecker({ calls: neverJudges });

    await check(criterion({ id: "c1" }), { tasks: [], cwd: process.cwd(), evidenceDir: dir });
    await check(criterion({ id: "c2" }), { tasks: [], cwd: process.cwd(), evidenceDir: dir });

    assert.deepEqual(fs.readdirSync(dir).sort(), ["criterion-c1.txt", "criterion-c2.txt"]);
  });

  test("with no directory the verdict carries no path, and the check still answers", async () => {
    const check = createCriterionChecker({ calls: neverJudges });

    const result = await check(criterion(), { tasks: [], cwd: process.cwd() });

    assert.equal(result.met, true);
    assert.equal(result.evidence.checkOutputPath, undefined);
  });
});

// The failure mode a panel exists for: one model's opinion terminating a mission. And
// the failure mode a panel *introduces*: three of them costing three calls to produce
// the last one's answer, or a dissent deleted from the record that resolved it.
describe("a judge panel", () => {
  const criterion = {
    id: "c1",
    statement: "the README documents the NaN policy",
    check: { kind: "judge" as const, rubric: "PASS if the file states it" },
  };

  /** One seat per verdict, in order, recording what each was asked. */
  const panelOf = (verdicts: readonly boolean[]) => {
    const asked: JudgeInput[] = [];
    const calls = {
      judge: async (input: JudgeInput) => {
        asked.push(input);
        const met = verdicts[asked.length - 1]!;
        return {
          met,
          evidence: {
            artifactIds: [`a${asked.length}`],
            checkOutput: "",
            reasoning: `seat ${asked.length - 1} says ${met}`,
            byTask: [`t${asked.length}`],
          },
        };
      },
    };
    return { asked, check: createCriterionChecker({ calls }) };
  };

  test("a 2-1 split resolves by quorum, not by whoever answered last", async () => {
    const { asked, check } = panelOf([true, true, false]);

    const result = await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      panel: ["correctness", "spec-compliance", "does-it-run"],
    });

    assert.equal(asked.length, 3);
    assert.equal(result.met, true);
    assert.deepEqual(
      result.votes?.map((vote) => [vote.seat, vote.lens, vote.met]),
      [
        [0, "correctness", true],
        [1, "spec-compliance", true],
        [2, "does-it-run", false],
      ],
    );
  });

  test("the same split the other way is unmet", async () => {
    const { check } = panelOf([false, true, false]);

    const result = await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      panel: ["correctness", "spec-compliance", "does-it-run"],
    });

    assert.equal(result.met, false);
  });

  test("each seat is asked through its own lens", async () => {
    const { asked, check } = panelOf([true, true, true]);

    await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      panel: ["correctness", "spec-compliance", "does-it-run"],
    });

    assert.deepEqual(
      asked.map((input) => input.lens),
      ["correctness", "spec-compliance", "does-it-run"],
    );
  });

  // A 2-1 that resolves `met: true` with the dissent deleted is a unanimous verdict as
  // far as anyone reading the mission later can tell.
  test("the resolved evidence keeps the dissent and says how it split", async () => {
    const { check } = panelOf([true, false, true]);

    const result = await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      panel: ["correctness", "spec-compliance", "does-it-run"],
    });

    assert.match(result.evidence.reasoning, /Panel of 3: 2 for, 1 against/);
    assert.match(result.evidence.reasoning, /seat 1 says false/);
    assert.deepEqual(result.evidence.byTask, ["t1", "t2", "t3"]);
  });

  test("every seat's own reasoning lands on disk beside the panel's answer", async () => {
    const dir = fs.mkdtempSync(path.join(scratch, "panel-"));
    const { check } = panelOf([true, true, false]);

    await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      evidenceDir: dir,
      panel: ["correctness", "spec-compliance", "does-it-run"],
    });

    assert.deepEqual(fs.readdirSync(dir).sort(), [
      "criterion-c1-correctness.txt",
      "criterion-c1-does-it-run.txt",
      "criterion-c1-spec-compliance.txt",
      "criterion-c1.txt",
    ]);
    assert.match(
      fs.readFileSync(path.join(dir, "criterion-c1-does-it-run.txt"), "utf8"),
      /seat 2 \(does-it-run\)/,
    );
  });

  // The identity case is the whole of "quick judge spend unchanged": one call, one
  // evidence file, and the seat's own words rather than a tally wrapped around them.
  test("a panel of one is the single judge it was before panels existed", async () => {
    const dir = fs.mkdtempSync(path.join(scratch, "panel-"));
    const { asked, check } = panelOf([true]);

    const result = await check(criterion, {
      tasks: [],
      cwd: process.cwd(),
      evidenceDir: dir,
      panel: [undefined],
    });

    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.lens, undefined);
    assert.equal(result.met, true);
    assert.equal(result.evidence.reasoning, "seat 0 says true");
    assert.deepEqual(fs.readdirSync(dir), ["criterion-c1.txt"]);
  });

  test("no panel at all is a panel of one, so an old caller is unchanged", async () => {
    const { asked, check } = panelOf([false]);

    const result = await check(criterion, { tasks: [], cwd: process.cwd() });

    assert.equal(asked.length, 1);
    assert.equal(result.met, false);
    assert.equal(result.evidence.reasoning, "seat 0 says false");
  });
});

// The specialist gate, end to end against a stub binary on PATH (PLAN-NEXT 6.3). The
// three answers that must never be confused: findings, clean, and broken. Reading the
// third as the second is a mission that passes its security criterion because nobody was
// logged in — which is why the exit code is interpreted rather than compared to zero.
describe("a scanner criterion", () => {
  const criterion = (patch = {}) => ({
    id: "sec",
    statement: "the changed files carry no high-severity vulnerability",
    check: { kind: "scanner" as const, scanner: "deepsec" as const },
    ...patch,
  });

  /** A task whose diff names files, which is the list the scan is bounded to. Real paths
   *  in this repository, because the gate drops anything not on the merged tree. */
  const contributor = (files = ["src/loop/verify.ts", "src/loop/scanner.ts"]) =>
    aCodeTask({
      id: "t1",
      artifacts: [
        { kind: "diff", id: "a1", branch: "feat/x", files, insertions: 2, deletions: 0 },
      ],
    });

  /**
   * A `deepsec` on PATH that does what the real one does: `process` exits 1 when it has
   * findings and 0 when it does not, `export` writes the JSON to `--out`. A real binary
   * in a real directory rather than an injected runner, because what is under test is
   * the argv and the exit codes — the two things a stub runner would assert about itself.
   */
  const withStub = (body: string) => {
    const dir = fs.mkdtempSync(path.join(scratch, "bin-"));
    fs.writeFileSync(path.join(dir, "deepsec"), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return dir;
  };

  const onPath = (dir: string, run: () => Promise<void>) => async () => {
    const before = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    try {
      await run();
    } finally {
      process.env.PATH = before;
    }
  };

  const FINDING = JSON.stringify([
    {
      title: "[HIGH] Command injection",
      description: "…",
      metadata: {
        filePath: "src/a.ts",
        severity: "HIGH",
        lineNumbers: [7],
        vulnSlug: "command-injection",
      },
    },
  ]);

  const stub = (exitCode: number, payload: string) => `
const argv = process.argv.slice(2);
if (argv[0] === "process") { console.log("scanning"); process.exit(${exitCode}); }
const out = argv[argv.indexOf("--out") + 1];
require("node:fs").writeFileSync(out, ${JSON.stringify(payload)});
`;

  test(
    "a finding fails the criterion and lands on disk",
    onPath(withStub(stub(1, FINDING)), async () => {
      const dir = fs.mkdtempSync(path.join(scratch, "scan-"));
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [contributor()],
        cwd: process.cwd(),
        evidenceDir: dir,
      });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /deepsec found 1 issue at HIGH or above/);
      assert.match(result.evidence.reasoning, /HIGH src\/a\.ts:7 — \[HIGH\] Command injection/);
      // The finding itself, not only a sentence about it (P2, defect 30).
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        "criterion-sec-deepsec.json",
        "criterion-sec.txt",
      ]);
      assert.match(fs.readFileSync(path.join(dir, "criterion-sec-deepsec.json"), "utf8"), /HIGH/);
    }),
  );

  test(
    "an empty export is a clean gate",
    onPath(withStub(stub(0, "[]")), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), { tasks: [contributor()], cwd: process.cwd() });

      assert.equal(result.met, true);
      assert.match(result.evidence.reasoning, /found nothing at HIGH or above in 2 files/);
    }),
  );

  // The two ends of the scanner's own credential exposure (PLAN-NEXT 7.3, found by the
  // stage's security review). A scan is an AI agent with shell access and a store that
  // persists in the repository: given the orchestrator's whole environment it starts
  // holding every value the mission granted, which is defect 42 one caller along; and its
  // export is a file this code copies into `.orchestra/` and then names to the human,
  // so a scanner quoting the hardcoded credential it just found would put that value on
  // disk through the one check whose whole job is to find it.
  test(
    "a scan is not given the granted values, and what it exports is scrubbed",
    onPath(
      withStub(`
const argv = process.argv.slice(2);
if (argv[0] === "process") { process.exit(1); }
const out = argv[argv.indexOf("--out") + 1];
require("node:fs").writeFileSync(out, JSON.stringify([{
  title: "[HIGH] Hardcoded credential",
  description: "found sk_live_9d8f7a6b5c4d in config; env holds " + (process.env.STRIPE_KEY ?? "absent"),
  metadata: { filePath: "src/a.ts", severity: "HIGH", lineNumbers: [7], vulnSlug: "secret" },
}]));
`),
      async () => {
        const dir = fs.mkdtempSync(path.join(scratch, "scan-secret-"));
        const before = process.env.STRIPE_KEY;
        process.env.STRIPE_KEY = "sk_live_9d8f7a6b5c4d";
        try {
          const check = createCriterionChecker({
            calls: neverJudges,
            secrets: [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b5c4d" }],
          });

          const result = await check(criterion(), {
            tasks: [contributor()],
            cwd: process.cwd(),
            evidenceDir: dir,
          });

          const exported = fs.readFileSync(path.join(dir, "criterion-sec-deepsec.json"), "utf8");
          assert.match(exported, /env holds absent/, "the scanner was handed the granted value");
          assert.equal(exported.includes("sk_live_9d8f7a6b5c4d"), false);
          assert.match(exported, /\[redacted:STRIPE_KEY\]/);
          assert.equal(result.evidence.reasoning.includes("sk_live_9d8f7a6b5c4d"), false);
          assert.equal(fs.statSync(path.join(dir, "criterion-sec-deepsec.json")).mode & 0o777, 0o600);
        } finally {
          if (before === undefined) delete process.env.STRIPE_KEY;
          else process.env.STRIPE_KEY = before;
        }
      },
    ),
  );

  // Exit 2 is deepsec's "runtime error" — most often no model credentials. Read as "did
  // not pass" it would fail a security criterion while the finding list stayed empty;
  // read as clean it would pass one nothing looked at. It is neither: it is broken.
  test(
    "a scanner that could not run fails the criterion and says why",
    onPath(withStub(`process.exit(2)`), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), { tasks: [contributor()], cwd: process.cwd() });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /broken scan and not a clean one/);
      assert.match(result.evidence.reasoning, /orchestra doctor/);
    }),
  );

  // Observed on a real scan (2026-08-16): a seeded vulnerable file came back
  // `Errored batches: 1` and exit 1 with an empty export, because the agent deepsec
  // drives had hit its account's usage limit. Read as clean, that is a security criterion
  // that passes because nobody was logged in.
  test(
    "exit 1 with nothing at all is a scan that never ran, not a clean one",
    onPath(withStub(stub(1, "[]")), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), { tasks: [contributor()], cwd: process.cwd() });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /exited 1 having produced no findings at all/);
      assert.match(result.evidence.reasoning, /credentials and quota/);
    }),
  );

  // The complement, and the reason the threshold is not deepsec's `--min-severity`: a
  // scan that ran and found only soft things is genuinely clean at HIGH, and must not be
  // confused with the case above.
  test(
    "findings below the threshold pass and are counted",
    onPath(
      withStub(
        stub(
          1,
          JSON.stringify([
            {
              title: "[LOW] Weak comment",
              metadata: { filePath: "src/a.ts", severity: "LOW", lineNumbers: [1] },
            },
          ]),
        ),
      ),
      async () => {
        const check = createCriterionChecker({ calls: neverJudges });

        const result = await check(criterion(), { tasks: [contributor()], cwd: process.cwd() });

        assert.equal(result.met, true);
        assert.match(result.evidence.reasoning, /1 below the threshold/);
      },
    ),
  );

  test(
    "an export whose shape moved is loud rather than clean",
    onPath(withStub(stub(1, '{"findings":[]}')), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), { tasks: [contributor()], cwd: process.cwd() });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /bare array of findings/);
    }),
  );

  // Nothing to scan is not the same as nothing found. A criterion nobody looked at has
  // not been shown, which is `kind: "none"`'s reading one branch over.
  test(
    "a criterion whose contributors left no diff is unmet, not clean",
    onPath(withStub(stub(0, "[]")), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [aCodeTask({ id: "t1", artifacts: [] })],
        cwd: process.cwd(),
      });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /had no files to look at/);
    }),
  );

  // `artifact.files` is a git diff's name list, so it includes deletions. Handing deepsec
  // a path that is not there errors the batch, and the operator reads "check your
  // credentials" about a criterion whose real problem is a removed file.
  test(
    "a file the mission deleted is not handed to the scanner",
    onPath(withStub(stub(0, "[]")), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [contributor(["src/loop/verify.ts", "src/deleted-by-this-mission.ts"])],
        cwd: process.cwd(),
      });

      assert.equal(result.met, true);
      assert.match(result.evidence.reasoning, /in 1 file: src\/loop\/verify\.ts/);
    }),
  );

  test(
    "every contributing file gone is a scan with nothing to look at, not a clean one",
    onPath(withStub(stub(0, "[]")), async () => {
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [contributor(["src/gone.ts"])],
        cwd: process.cwd(),
      });

      assert.equal(result.met, false);
      assert.match(result.evidence.reasoning, /had no files to look at/);
    }),
  );

  // deepsec bills per file investigated; its own figures put 2,000 files in the hundreds
  // of dollars. Refusing with the number is a better answer than a bill nobody approved.
  test(
    "too many changed files refuses rather than spends",
    onPath(withStub(stub(0, "[]")), async () => {
      const many = fs
        .readdirSync(path.join(process.cwd(), "src", "loop"))
        .map((name) => `src/loop/${name}`);
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [contributor(many)],
        cwd: process.cwd(),
      });

      // The suite is the guard here: if `src/loop` ever holds 200 files this stops
      // asserting anything, so it says so rather than passing quietly.
      assert.ok(many.length < MAX_SCANNED_FILES, "src/loop outgrew the cap; pick another set");
      assert.equal(result.met, true);
    }),
  );

  // The path is the same every round and `readFileSync` succeeding is the only evidence
  // this code has that an export happened. A round whose export writes nothing would
  // otherwise grade the previous round's findings.
  test(
    "a stale export from an earlier round is never graded",
    onPath(
      // A scanner that exits 1 and writes nothing at all, which is the shape that made
      // this reachable.
      withStub(`if (process.argv[2] === "process") { process.exit(1); } process.exit(0);`),
      async () => {
        const dir = fs.mkdtempSync(path.join(scratch, "stale-"));
        fs.writeFileSync(path.join(dir, "criterion-sec-deepsec.json"), "[]");

        const check = createCriterionChecker({ calls: neverJudges });
        const result = await check(criterion(), {
          tasks: [contributor()],
          cwd: process.cwd(),
          evidenceDir: dir,
        });

        assert.equal(result.met, false);
        assert.match(result.evidence.reasoning, /wrote nothing to/);
      },
    ),
  );

  // `--out` names a file in a directory deepsec will not create. An artifact root that
  // nothing has written to yet would turn a clean scan into "the export failed".
  test(
    "an evidence directory that does not exist yet is created before the export",
    onPath(withStub(stub(0, "[]")), async () => {
      const dir = path.join(scratch, `unwritten-${Date.now()}`);
      const check = createCriterionChecker({ calls: neverJudges });

      const result = await check(criterion(), {
        tasks: [contributor()],
        cwd: process.cwd(),
        evidenceDir: dir,
      });

      assert.equal(result.met, true);
      assert.ok(fs.existsSync(path.join(dir, "criterion-sec-deepsec.json")));
    }),
  );

  // A scan grades the merged outcome. Run per task it would bill the mission once per
  // task for an answer about a tree that does not exist yet.
  test("a task-level scanner check is refused, and the message says where to put it", async () => {
    const verify = createVerifier({ calls: neverJudges });

    const result = await verify(
      { kind: "scanner", scanner: "deepsec" },
      context({ task: contributor() }),
    );

    assert.equal(result.passed, false);
    assert.match(result.output, /grades the merged repository/);
    assert.match(result.output, /outcome criterion/);
  });
});
