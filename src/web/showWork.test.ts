// The one place the dashboard opens a file, against a real repo and a real tmp dir
// (PLAN-NEXT 9.3).
//
// Two failure modes, and the second is the one worth the setup. The first is a diff
// that is empty, or is somebody else's — a merge range read off the wrong attempt.
// The second is a path: this module is reachable from a socket, so "an id that names
// nothing is refused" is not a nicety, it is the whole reason a browser cannot ask
// this process to read `/etc/passwd`. Both are asserted with git actually running,
// because a fake repo would encode the same assumption the code does.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { git } from "../git/repo.js";
import { type Event, type EventInput } from "../events/schema.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";
import { stamp } from "../testing/fixtures.js";
import { showWork } from "./showWork.js";

const repos: TestRepo[] = [];
const dirs: string[] = [];
after(() => {
  for (const repo of repos) repo.cleanup();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const tmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-show-"));
  dirs.push(dir);
  return dir;
};

/** A repo whose `main` gained one commit on a branch that was then merged, and the log
 *  that records it — which is exactly what a task landing its work leaves behind. */
async function mergedRepo(): Promise<{ repo: TestRepo; events: Event[] }> {
  const repo = await makeRepo("orchestra-show-repo-");
  repos.push(repo);

  const base = await repo.head();
  await git(repo.path, ["checkout", "-b", "orchestra/t1"]);
  await repo.writeAndCommit("added.ts", "export const answer = 42;\n", "add answer");
  await git(repo.path, ["checkout", "main"]);
  await git(repo.path, ["merge", "--no-ff", "-m", "merge t1", "orchestra/t1"]);
  const result = await repo.head();

  return {
    repo,
    events: stamp([
      { type: "merge_started", missionId: "m1", taskId: "t1", actor: "orchestrator", branch: "orchestra/t1", intoSha: base },
      { type: "merge_completed", missionId: "m1", taskId: "t1", actor: "orchestrator", branch: "orchestra/t1", resultSha: result },
    ] as EventInput[]),
  };
}

describe("showWork: a task's merged diff", () => {
  test("renders the patch and the stat for the range the log recorded", async () => {
    const { repo, events } = await mergedRepo();

    const result = await showWork({ what: "diff", id: "t1" }, { events, repoRoot: repo.path });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.shown.text.includes("added.ts"), "the file list is there");
    assert.ok(result.ok && result.shown.text.includes("+export const answer = 42;"), "so is the patch");
    assert.ok(result.ok && result.shown.title.includes("orchestra/t1"));
  });

  test("a task that never merged is refused by name rather than shown an empty diff", async () => {
    const { repo, events } = await mergedRepo();

    const result = await showWork({ what: "diff", id: "t9" }, { events, repoRoot: repo.path });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.includes("t9"));
  });

  // Defect 31's shape one layer up: a merge that conflicted or was empty has no second
  // sha, and rendering it as a diff of nothing would report destroyed work as success.
  test("a merge that started and never completed says so", async () => {
    const events = stamp([
      { type: "merge_started", missionId: "m1", taskId: "t1", actor: "orchestrator", branch: "orchestra/t1", intoSha: "a".repeat(40) },
    ] as EventInput[]);

    const result = await showWork({ what: "diff", id: "t1" }, { events, repoRoot: "/nowhere" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.includes("never completed"));
  });

  // Under `serve`, a mission scoped to a directory that is not a workspace here gets no
  // repo — the same refusal `resume` makes. The message has to name the command that
  // would work, or somebody goes looking for a bug in the merge.
  test("no checkout is a refusal that names the git command instead", async () => {
    const { events } = await mergedRepo();

    const result = await showWork({ what: "diff", id: "t1" }, { events });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.includes("git diff"));
  });

  // The only way either sha is not a sha is a hand-edited log, which `registry.ts`
  // already treats as a thing that happens — and a leading `-` in the argument vector
  // is an option rather than a revision.
  test("a range that is not a pair of shas never reaches git", async () => {
    const repo = await makeRepo("orchestra-show-bad-");
    repos.push(repo);
    const events = stamp([
      { type: "merge_started", missionId: "m1", taskId: "t1", actor: "orchestrator", branch: "b", intoSha: "--upload-pack=touch" },
      { type: "merge_completed", missionId: "m1", taskId: "t1", actor: "orchestrator", branch: "b", resultSha: "HEAD" },
    ] as EventInput[]);

    const result = await showWork({ what: "diff", id: "t1" }, { events, repoRoot: repo.path });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.includes("not a pair of shas"));
  });
});

describe("showWork: a file the mission wrote", () => {
  const evidenceLog = (file: string): Event[] =>
    stamp([
      {
        type: "criterion_checked",
        missionId: "m1",
        actor: "orchestrator",
        criterionId: "c1",
        met: true,
        evidence: { artifactIds: [], checkOutput: "", reasoning: "", byTask: [], checkOutputPath: file },
      },
    ] as EventInput[]);

  test("opens the evidence file the log recorded, by the id of that event", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "criterion-c1.txt");
    fs.writeFileSync(file, "criterion: c1\nmet: true\n");

    const result = await showWork({ what: "file", id: "1" }, { events: evidenceLog(file) });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.shown.text.includes("met: true"));
    assert.equal(result.ok && result.shown.title, "criterion c1");
  });

  // The one that matters. Every path this module opens comes from the log; an id that
  // is not in the listing is refused before anything reaches `readFileSync`, which is
  // what stops a socket from being an arbitrary read.
  test("an id that names nothing in the log is refused, whatever it looks like", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "criterion-c1.txt");
    fs.writeFileSync(file, "evidence\n");
    const events = evidenceLog(file);

    for (const id of ["/etc/passwd", "../../etc/passwd", "2", "criterion-c1.txt", file]) {
      const result = await showWork({ what: "file", id }, { events });
      assert.equal(result.ok, false, id);
      assert.ok(!result.ok && result.problem.includes("not one this mission recorded"), id);
    }
  });

  // Defect 30's standing reminder: a string in a log cannot re-open a file somebody
  // deleted, and naming the path that was tried is what turns that into a diagnosis.
  test("a recorded file that is gone names the path it looked at", async () => {
    const missing = path.join(tmpDir(), "criterion-c1.txt");

    const result = await showWork({ what: "file", id: "1" }, { events: evidenceLog(missing) });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.includes(missing));
  });

  test("a file past the limit comes back truncated and says so", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "criterion-c1.txt");
    fs.writeFileSync(file, "line\n".repeat(80_000));

    const result = await showWork({ what: "file", id: "1" }, { events: evidenceLog(file) });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.shown.truncated, true);
    assert.ok(result.ok && result.shown.text.length <= 200_000);
  });
});
