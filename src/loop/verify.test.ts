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
import { createCriterionChecker, createVerifier } from "./verify.js";

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
