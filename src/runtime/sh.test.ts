// §9.6. A timeout used to go straight to SIGKILL, so a worker never got the chance
// to flush or clean up; output accumulated without bound; and a missing binary
// surfaced as a raw ENOENT.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProcessStartError, run } from "./sh.js";

const node = (script: string) => ["-e", script] as const;

describe("run", () => {
  // `child.stdin.end()` at the bottom of `run` reads like tidiness beside the `opts.input`
  // write it follows, and it is load-bearing: a child that waits for EOF on stdin never
  // finishes without it. `pi -p` is one such child — the same command returned in under a
  // second with stdin redirected from /dev/null and hung past two minutes with a pipe attached
  // (`src/testing/cli-transcripts/README.md`) — and a worker in that state burns its whole
  // wall-clock budget and is then recorded as a timeout, which points an investigation at the
  // model rather than at the spawn. `claude` and `codex` do not care, so nothing else here
  // would fail if the line went; this is what fails.
  test("closes the child's stdin, so a child that waits for EOF finishes", async () => {
    const result = await run("node", [
      ...node(
        'const c=[];process.stdin.on("data",(d)=>c.push(d));' +
          'process.stdin.on("end",()=>process.stdout.write("eof:"+c.join("")));',
      ),
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "eof:");
    assert.equal(result.timedOut, false);
  });

  test("captures stdout and the exit code", async () => {
    const result = await run("node", [...node('process.stdout.write("hi")')]);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hi");
    assert.equal(result.timedOut, false);
  });

  // §9.5: wall-clock is the ceiling a budget actually binds on, and until this landed
  // nothing in the runtime measured it.
  test("reports how long the process took", async () => {
    const result = await run("node", [...node("setTimeout(() => {}, 120)")]);

    assert.ok(result.elapsedMs >= 100, `got ${result.elapsedMs}ms`);
    assert.ok(result.elapsedMs < 30_000, `got ${result.elapsedMs}ms`);
  });

  test("captures stderr separately", async () => {
    const result = await run("node", [...node('process.stderr.write("bad"); process.exit(3)')]);

    assert.equal(result.code, 3);
    assert.equal(result.stderr, "bad");
  });

  test("passes arguments as argv, so quoting is never reinterpreted", async () => {
    const result = await run("node", [...node("process.stdout.write(process.argv[1])"), "a b c"]);

    assert.equal(result.stdout, "a b c");
  });

  // Defect 8: a chatty worker in an hours-long loop was an OOM.
  test("caps output instead of accumulating it without bound", async () => {
    const result = await run(
      "node",
      [...node('for (let i = 0; i < 20000; i++) process.stdout.write("noisy line\\n")')],
      { maxOutputBytes: 1024 },
    );

    assert.ok(result.stdout.length < 1200, `got ${result.stdout.length} bytes`);
    assert.ok(result.dropped > 0);
    assert.match(result.stdout, /bytes dropped/);
  });

  describe("timeouts", () => {
    test("terminates a hung process and says that it timed out", async () => {
      const result = await run("node", [...node("setTimeout(() => {}, 60000)")], {
        timeoutMs: 200,
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.signal, "SIGTERM");
    });

    // The escalation exists so a well-behaved worker gets to clean up its worktree,
    // and a wedged one still dies.
    //
    // The timeout is generous on purpose: the child has to finish booting and install
    // its handler before SIGTERM arrives, and node startup under a parallel test run
    // is hundreds of milliseconds. A tight timeout here tests node's boot time.
    test("escalates to SIGKILL when the process ignores SIGTERM", async () => {
      const result = await run(
        "node",
        [...node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')],
        { timeoutMs: 3000, graceMs: 250 },
      );

      assert.equal(result.timedOut, true);
      assert.equal(result.signal, "SIGKILL");
    });

    test("keeps whatever the process managed to print before it was killed", async () => {
      const result = await run(
        "node",
        [...node('process.stdout.write("partial"); setTimeout(() => {}, 60000)')],
        { timeoutMs: 3000 },
      );

      assert.equal(result.stdout, "partial");
    });
  });

  test("an abort signal terminates the process the same way", async () => {
    const controller = new AbortController();
    const pending = run("node", [...node("setTimeout(() => {}, 60000)")], {
      signal: controller.signal,
    });

    controller.abort();

    assert.equal((await pending).signal, "SIGTERM");
  });

  // `duplex.ts`'s bug, in the file it was copied from. `terminate` signalled the pid it
  // spawned, and a target that forks — `npx`, `npm exec`, a shell running a pipeline —
  // leaves the real work in a grandchild that survives the timeout, holds the stdout pipe
  // open, and keeps `close` from ever firing. A worker then burns forever instead of
  // failing at its budget.
  // The grandchild outlives the test's own 20s patience on purpose: a version that slept
  // for less than the test's own patience passed by waiting the orphan out, which is the
  // bug wearing a green tick.
  test("a timeout terminates the whole process group, not just the spawned pid", { timeout: 20_000 }, async () => {
    const result = await run("sh", ["-c", 'sleep 60 & echo "$!"; wait'], { timeoutMs: 2000 });
    const grandchild = Number(result.stdout.trim());

    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.equal(result.timedOut, true);
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
  });

  // §2a rule 5: `codex not found on PATH` beats a raw ENOENT.
  test("a missing binary fails with a message naming the binary", async () => {
    const err = await run("definitely-not-installed-xyz", []).catch((e: unknown) => e);

    assert.ok(err instanceof ProcessStartError);
    assert.match(err.message, /definitely-not-installed-xyz not found on PATH/);
    assert.equal(err.failure, "transport");
  });

  test("feeds stdin when input is provided", async () => {
    const result = await run(
      "node",
      [...node('process.stdin.on("data", (d) => process.stdout.write(d))')],
      { input: "echoed" },
    );

    assert.equal(result.stdout, "echoed");
  });
});
