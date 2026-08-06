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
import { createVerifier } from "./verify.js";

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
});
