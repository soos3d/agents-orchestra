// Against a real git repo, because every failure this joins up is a git failure:
// a branch that merged before it was verified, a worktree cut from the wrong base, a
// worker whose diff touched files another task owns.
//
// The transport is fake and the git is real, which is the right way round — a fake
// git would encode the same assumptions the defects came from.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { type Task } from "../domain/task.js";
import { type EventInput } from "../events/schema.js";
import { createMergeQueue } from "../git/mergeQueue.js";
import { git } from "../git/repo.js";
import { aCodeTask, aReport } from "../testing/fixtures.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";
import { dispatch, type DispatchDeps, type WorkerTransport } from "./dispatch.js";
import { type Verifier } from "./verify.js";

const passes: Verifier = async () => ({ passed: true, output: "exit 0" });
const fails: Verifier = async () => ({ passed: false, output: "exit 1\n1 test failed" });

/** A worker that writes the files it was told to, commits them, and reports. */
const worker =
  (files: Record<string, string>, report = aReport()): WorkerTransport =>
  async ({ cwd }) => {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(cwd, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "worker"]);
    return { raw: JSON.stringify(report), elapsedMs: 1234 };
  };

/** A worker that writes its files and leaves them uncommitted, which is what a real
 *  one does unless something else commits for it (defect 30). */
const writes =
  (files: Record<string, string>, report = aReport()): WorkerTransport =>
  async ({ cwd }) => {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(cwd, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return { raw: JSON.stringify(report), elapsedMs: 1234 };
  };

describe("dispatch", () => {
  let repo: TestRepo;
  let events: EventInput[];

  const deps = (patch: Partial<DispatchDeps> = {}): DispatchDeps => ({
    emit: (event) => events.push(event),
    transport: worker({ "src/routes/health.ts": "export const health = () => 200;\n" }),
    verify: passes,
    code: {
      repo: repo.path,
      worktreeRoot: repo.worktreeRoot,
      into: "main",
      mergeQueue: createMergeQueue(repo.path),
    },
    ...patch,
  });

  const types = () => events.map((event) => event.type);
  const statuses = () =>
    events.flatMap((event) => (event.type === "task_status" ? [event.to] : []));
  const onMain = (file: string) => fs.existsSync(path.join(repo.path, file));

  before(async () => {
    repo = await makeRepo("orchestra-dispatch-");
  });
  after(() => repo.cleanup());

  describe("a code task that works", () => {
    let task: Task;

    before(async () => {
      events = [];
      task = aCodeTask({ branch: "feat/health", owns: ["src/routes/health.ts"] });
      const outcome = await dispatch(task, deps());
      assert.deepEqual(outcome, { status: "done" });
    });

    test("takes the lease, cuts a worktree from a pinned base, and cleans it up", () => {
      assert.deepEqual(types().slice(0, 3), ["lease_granted", "worktree_created", "task_status"]);
      const created = events.find((event) => event.type === "worktree_created");
      assert.ok(created && "baseSha" in created && created.baseSha.length === 40);
      assert.ok(types().includes("worktree_removed"));
      assert.equal(fs.existsSync(path.join(repo.worktreeRoot, "feat_health")), false);
    });

    test("verifies before it merges, and reaches done", () => {
      const order = types();
      assert.ok(order.indexOf("verification_run") < order.indexOf("merge_started"));
      assert.deepEqual(statuses(), ["running", "verifying", "done"]);
    });

    test("lands the work on the integration branch", () => {
      assert.equal(onMain("src/routes/health.ts"), true);
    });

    // §9.5: a CLI worker reports no tokens, and a spend line of ~0 would read as a
    // cheap mission when most of it is invisible.
    test("records honest unmeasured spend", () => {
      const spend = events.find((event) => event.type === "spend_recorded");
      assert.ok(spend && "spend" in spend);
      assert.equal(spend.spend.tokens.unmeasured, 1);
      assert.equal(spend.spend.tokens.measured, 0);
      assert.equal(spend.spend.wallMs, 1234);
      assert.equal(spend.spend.dispatches, 1);
    });
  });

  test("a transport that reports usage records it as measured", async () => {
    events = [];
    const measured: WorkerTransport = async () => ({
      raw: JSON.stringify(aReport()),
      elapsedMs: 10,
      measuredTokens: 4200,
    });

    await dispatch(
      aCodeTask({ branch: "feat/measured", owns: ["src/measured.ts"] }),
      deps({ transport: measured }),
    );

    const spend = events.find((event) => event.type === "spend_recorded");
    assert.equal(spend && "spend" in spend && spend.spend.tokens.measured, 4200);
    assert.equal(spend && "spend" in spend && spend.spend.tokens.unmeasured, 0);
  });

  // The Phase 1 milestone that was waiting on a dispatcher to assert it.
  describe("a task that fails verification", () => {
    before(async () => {
      events = [];
      await dispatch(
        aCodeTask({ branch: "feat/broken", owns: ["src/broken.ts"] }),
        deps({
          transport: worker({ "src/broken.ts": "throw new Error('nope');\n" }),
          verify: fails,
        }),
      );
    });

    test("is blocked from merging", () => {
      assert.equal(types().includes("merge_started"), false);
      assert.equal(onMain("src/broken.ts"), false);
    });

    test("fails with the check output, which is what a fix task needs", async () => {
      const outcome = await dispatch(
        aCodeTask({ branch: "feat/broken2", owns: ["src/broken2.ts"] }),
        deps({
          transport: worker({ "src/broken2.ts": "throw new Error('nope');\n" }),
          verify: fails,
        }),
      );

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.status === "failed" && outcome.failure, "verification");
      assert.match(outcome.status === "failed" ? outcome.message : "", /1 test failed/);
    });

    test("keeps the branch so the work is not thrown away", async () => {
      const branches = await git(repo.path, ["branch", "--list", "feat/broken"]);
      assert.match(branches, /feat\/broken/);
    });
  });

  describe("a worker that writes outside its lease", () => {
    let outcome: Awaited<ReturnType<typeof dispatch>>;

    before(async () => {
      events = [];
      outcome = await dispatch(
        aCodeTask({ branch: "feat/escape", owns: ["src/declared.ts"] }),
        deps({
          transport: worker({
            "src/declared.ts": "export const a = 1;\n",
            "src/sneaky.ts": "export const b = 2;\n",
          }),
        }),
      );
    });

    test("fails the task and names what it touched", () => {
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.status === "failed" && outcome.failure, "lease_escape");
      const escaped = events.find((event) => event.type === "lease_escaped");
      assert.deepEqual(escaped && "touched" in escaped && escaped.touched, ["src/sneaky.ts"]);
    });

    // The escape invalidated the diff, so verifying it would grade the wrong thing.
    test("never verifies and never merges", () => {
      assert.equal(types().includes("verification_run"), false);
      assert.equal(types().includes("merge_started"), false);
      assert.equal(onMain("src/sneaky.ts"), false);
    });
  });

  // Defect 30, found on the first real coding mission to reach the merge step: the
  // worker wrote its files, verification passed against the dirty worktree, the merge
  // merged a branch still sitting on its base and reported success, and the worktree
  // was removed. The work was verified and then destroyed.
  describe("a worker that leaves its work uncommitted", () => {
    let outcome: Awaited<ReturnType<typeof dispatch>>;

    before(async () => {
      events = [];
      outcome = await dispatch(
        aCodeTask({ branch: "feat/uncommitted", owns: ["src/uncommitted.ts"] }),
        deps({ transport: writes({ "src/uncommitted.ts": "export const a = 1;\n" }) }),
      );
    });

    test("has it committed for it, on its own branch, naming the task", async () => {
      assert.deepEqual(outcome, { status: "done" });
      const log = await git(repo.path, ["log", "-1", "--pretty=%s", "feat/uncommitted"]);
      assert.match(log, /t1/);
    });

    test("lands the work on the integration branch rather than a merge of nothing", async () => {
      assert.equal(onMain("src/uncommitted.ts"), true);
      const merged = events.find((event) => event.type === "merge_completed");
      const started = events.find((event) => event.type === "merge_started");
      assert.ok(merged && "resultSha" in merged && started && "intoSha" in started);
      assert.notEqual(merged.resultSha, started.intoSha);
    });

    // The commit runs before the escape check, so §8 still reads exactly what the
    // worker wrote — a commit that hid the files would disable a whole section.
    test("still catches a worker that wrote outside its lease", async () => {
      events = [];
      const escaped = await dispatch(
        aCodeTask({ branch: "feat/uncommitted-escape", owns: ["src/declared2.ts"] }),
        deps({
          transport: writes({
            "src/declared2.ts": "export const a = 1;\n",
            "src/sneaky2.ts": "export const b = 2;\n",
          }),
        }),
      );

      assert.equal(escaped.status === "failed" && escaped.failure, "lease_escape");
      const event = events.find((e) => e.type === "lease_escaped");
      assert.deepEqual(event && "touched" in event ? event.touched : [], ["src/sneaky2.ts"]);
      assert.equal(onMain("src/sneaky2.ts"), false);
    });
  });

  // Defect 31: the same run's real failure mode, one step on. A merge of nothing must
  // not read as work landing.
  describe("a worker that changed nothing", () => {
    let outcome: Awaited<ReturnType<typeof dispatch>>;

    before(async () => {
      events = [];
      outcome = await dispatch(
        aCodeTask({ branch: "feat/nothing", owns: ["src/nothing.ts"] }),
        deps({ transport: writes({}) }),
      );
    });

    test("fails the task with a message naming what happened", () => {
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.status === "failed" && outcome.failure, "empty_merge");
      assert.match(
        outcome.status === "failed" ? outcome.message : "",
        /no commits of its own/,
      );
    });

    test("never reports the merge as completed", () => {
      assert.equal(types().includes("merge_completed"), false);
      assert.ok(types().includes("merge_empty"));
    });

    // Whatever the worker did do is the only record of it, so the worktree stays for
    // a human to look at. Everything else about a failure removes it.
    test("keeps the worktree so anything dirty survives inspection", () => {
      assert.equal(types().includes("worktree_removed"), false);
      assert.equal(fs.existsSync(path.join(repo.worktreeRoot, "feat_nothing")), true);
    });
  });

  test("refuses a dispatch overlapping a held lease, changing nothing", async () => {
    events = [];
    const outcome = await dispatch(
      aCodeTask({ branch: "fix/router", owns: ["src/routes/**"] }),
      deps({ held: [{ taskId: "t9", owns: ["src/routes/health.ts"] }] }),
    );

    assert.equal(outcome.status, "not_dispatched");
    assert.deepEqual(types(), ["lease_rejected"]);
  });

  test("a worker that reports blocked parks the task and releases the worktree", async () => {
    events = [];
    const outcome = await dispatch(
      aCodeTask({ branch: "feat/asks", owns: ["src/asks.ts"] }),
      deps({
        transport: worker({ "src/asks.ts": "" }, aReport({ outcome: "blocked", summary: "which account?" })),
      }),
    );

    assert.equal(outcome.status, "blocked");
    assert.deepEqual(statuses(), ["running", "blocked"]);
    assert.ok(types().includes("worktree_removed"));
  });

  test("a worker that cannot start is a transport failure", async () => {
    events = [];
    const outcome = await dispatch(
      aCodeTask({ branch: "feat/nostart", owns: ["src/nostart.ts"] }),
      deps({
        transport: async () => {
          throw Object.assign(new Error("claude not found on PATH"), { failure: "transport" });
        },
      }),
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.failure, "transport");
    assert.ok(types().includes("worktree_removed"));
  });

  // §4.1: the report is the orchestrator's entire evidence base, so a worker that
  // cannot produce one has told us nothing about the work.
  test("a worker returning prose fails as a transport error", async () => {
    events = [];
    const outcome = await dispatch(
      aCodeTask({ branch: "feat/prose", owns: ["src/prose.ts"] }),
      deps({ transport: async () => ({ raw: "I had a look and it seems fine!", elapsedMs: 5 }) }),
    );

    assert.equal(outcome.status === "failed" && outcome.failure, "transport");
  });

  // The base this worktree was cut from is asserted at merge, not assumed. A task
  // dispatched before another one landed is merged against a branch that moved, and
  // merging anyway is how one task's work silently reverts another's (defect 10).
  test("stops at conflicted when the integration branch moved underneath it", async () => {
    events = [];
    const racing: WorkerTransport = async (input) => {
      const run = await worker({ "src/racing.ts": "export const a = 1;\n" })(input);
      await repo.writeAndCommit("src/landed-first.ts", "another task got there first\n");
      return run;
    };

    const outcome = await dispatch(
      aCodeTask({ branch: "feat/racing", owns: ["src/racing.ts"] }),
      deps({ transport: racing }),
    );

    assert.equal(outcome.status, "conflicted");
    assert.match(outcome.status === "conflicted" ? outcome.message : "", /moved from/);
    assert.deepEqual(statuses(), ["running", "verifying", "conflicted"]);
    assert.ok(types().includes("merge_conflicted"));
    assert.equal(onMain("src/racing.ts"), false);
  });

  describe("work with no repo", () => {
    test("runs a research task in place, with no worktree and no merge", async () => {
      events = [];
      const research = {
        ...aCodeTask({ id: "r1", worker: "research" }),
        worker: "research",
        branch: undefined,
        owns: undefined,
        verify: { kind: "judge" as const, rubric: "the brief answers the question" },
      } as unknown as Task;

      const outcome = await dispatch(research, {
        emit: (event) => events.push(event),
        transport: async () => ({ raw: JSON.stringify(aReport()), elapsedMs: 20 }),
        verify: passes,
        cwd: repo.path,
      });

      assert.deepEqual(outcome, { status: "done" });
      assert.equal(types().includes("worktree_created"), false);
      assert.equal(types().includes("lease_granted"), false);
      assert.equal(types().includes("merge_started"), false);
      assert.deepEqual(statuses(), ["running", "verifying", "done"]);
    });

    test("completes outside a git repository, where there is no checkout to protect", async () => {
      events = [];
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-norepo-"));
      try {
        const outcome = await dispatch(nonCode("r2", "research"), {
          emit: (event) => events.push(event),
          transport: async ({ cwd }) => {
            fs.writeFileSync(path.join(cwd, "brief.md"), "# findings\n");
            return { raw: JSON.stringify(aReport()), elapsedMs: 20 };
          },
          verify: passes,
          cwd: elsewhere,
        });

        assert.deepEqual(outcome, { status: "done" });
        assert.equal(types().includes("repo_escaped"), false);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  // Defect 41. Run 8's `consistency-audit` was staffed `review`, told to "fix any
  // problems you find directly", and did — in the repository checkout, where §4 gives
  // it no worktree, no lease, no commit and no escape check. The changes were never
  // versioned, and the criterion checks, which run with `cwd` = the repo, graded a
  // working tree containing them. The mission reported `complete`.
  describe("a non-code worker that edits the checkout", () => {
    let outcome: Awaited<ReturnType<typeof dispatch>>;

    before(async () => {
      events = [];
      outcome = await dispatch(nonCode("t41", "review"), {
        emit: (event) => events.push(event),
        transport: async ({ cwd }) => {
          fs.writeFileSync(path.join(cwd, "audit-check.mjs"), "// added by the auditor\n");
          return { raw: JSON.stringify(aReport()), elapsedMs: 20 };
        },
        verify: passes,
        cwd: repo.path,
      });
    });

    after(() => fs.rmSync(path.join(repo.path, "audit-check.mjs"), { force: true }));

    test("fails the task without retry, naming the file and the fix", () => {
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.status === "failed" && outcome.failure, "repo_escape");
      assert.match(outcome.status === "failed" ? outcome.message : "", /audit-check\.mjs/);
      assert.match(outcome.status === "failed" ? outcome.message : "", /`code` task/);
    });

    test("records what was touched, as its own event rather than a lease escape", () => {
      const escaped = events.find((event) => event.type === "repo_escaped");
      assert.ok(escaped && "touched" in escaped);
      assert.deepEqual(escaped.touched, ["audit-check.mjs"]);
      assert.equal(escaped && "worker" in escaped && escaped.worker, "review");
      assert.equal(types().includes("lease_escaped"), false);
    });

    // The check runs before verification for the same reason the lease check does: a
    // check over a dirty checkout grades changes that never landed.
    test("never verifies the work it would have graded", () => {
      assert.equal(types().includes("verification_run"), false);
      assert.deepEqual(statuses(), ["running", "failed"]);
    });

    test("leaves the worker's changes where they are", () => {
      assert.equal(onMain("audit-check.mjs"), true);
    });
  });

  test("a checkout the human already left dirty is not blamed on the worker", async () => {
    events = [];
    const theirs = path.join(repo.path, "human-notes.txt");
    fs.writeFileSync(theirs, "my own uncommitted work\n");
    try {
      const outcome = await dispatch(nonCode("t42", "research"), {
        emit: (event) => events.push(event),
        transport: async () => ({ raw: JSON.stringify(aReport()), elapsedMs: 20 }),
        verify: passes,
        cwd: repo.path,
      });

      assert.deepEqual(outcome, { status: "done" });
      assert.equal(types().includes("repo_escaped"), false);
    } finally {
      fs.rmSync(theirs, { force: true });
    }
  });
});

/** A task of a kind §4 gives no git to: no branch, no lease, no worktree. */
const nonCode = (id: string, worker: "research" | "review" | "general"): Task =>
  ({
    ...aCodeTask({ id, worker }),
    branch: undefined,
    owns: undefined,
    verify: { kind: "judge" as const, rubric: "the work answers the goal" },
  }) as unknown as Task;
