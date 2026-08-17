// §9.6, one process kind further than `sh.ts`. The failure mode under test is an
// orphaned long-lived agent: an ACP worker holds its stdio open for a whole session,
// so nothing about it "completes", and a timeout, an abort, or a caller that simply
// forgets it must still leave no process behind. Also under test: the two ways a
// session leaks memory instead of processes — stderr accumulated into an unbounded
// string over hours, and stdout buffered by us rather than handed to the reader.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProcessStartError } from "./sh.js";
import { spawnDuplex } from "./duplex.js";

const node = (script: string) => ["-e", script];

/** Resolve when the child's stdout has produced text matching `re`. */
function waitForOutput(stream: NodeJS.ReadableStream, re: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${re}; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      seen += chunk.toString();
      if (re.test(seen)) {
        cleanup();
        resolve(seen);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };
    stream.on("data", onData);
  });
}

const ECHO_UPPER = 'process.stdin.on("data", (d) => process.stdout.write(d.toString().toUpperCase()))';

describe("spawnDuplex", () => {
  test("carries a round trip over stdio while the process stays open", async () => {
    const proc = spawnDuplex("node", node(ECHO_UPPER), { cwd: process.cwd(), timeoutMs: 10_000 });

    proc.stdin.write("hello\n");
    assert.match(await waitForOutput(proc.stdout, /HELLO/), /HELLO/);

    // Still alive, and a second exchange proves the stream was not a one-shot.
    proc.stdin.write("again\n");
    assert.match(await waitForOutput(proc.stdout, /AGAIN/), /AGAIN/);

    await proc.kill();
  });

  test("reports the pid of the running session", async () => {
    const proc = spawnDuplex("node", node(ECHO_UPPER), { cwd: process.cwd(), timeoutMs: 10_000 });

    proc.stdin.write("x\n");
    await waitForOutput(proc.stdout, /X/);

    assert.equal(typeof proc.pid, "number");
    await proc.kill();
  });

  test("resolves with the exit code when the process ends on its own", async () => {
    const proc = spawnDuplex("node", node("process.exit(3)"), {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    const exit = await proc.exited;

    assert.equal(exit.code, 3);
    assert.equal(exit.timedOut, false);
    assert.equal(exit.aborted, false);
    assert.equal(exit.signal, null);
    assert.ok(exit.elapsedMs >= 0);
  });

  test("closing stdin ends a child that reads to end of input", async () => {
    const proc = spawnDuplex(
      "node",
      node('process.stdin.on("end", () => process.exit(0)); process.stdin.resume()'),
      { cwd: process.cwd(), timeoutMs: 10_000 },
    );

    proc.stdin.end();

    assert.equal((await proc.exited).code, 0);
  });

  test("runs in the cwd it was given", async () => {
    const proc = spawnDuplex("node", node("process.stdout.write(process.cwd())"), {
      cwd: "/tmp",
      timeoutMs: 10_000,
    });

    assert.match(await waitForOutput(proc.stdout, /tmp/), /tmp/);
    await proc.exited;
  });

  describe("nothing outlives its session", () => {
    test("a timeout terminates the process and says so", async () => {
      const proc = spawnDuplex("node", node("setInterval(() => {}, 1000)"), {
        cwd: process.cwd(),
        timeoutMs: 300,
      });

      const exit = await proc.exited;

      assert.equal(exit.timedOut, true);
      assert.equal(exit.aborted, false);
      assert.equal(exit.signal, "SIGTERM");
    });

    // The same escalation `sh.ts` makes: a well-behaved agent gets to flush its
    // session, a wedged one still dies. The timeout is generous because the child
    // has to boot before it can install the handler.
    test("escalates to SIGKILL when the process ignores SIGTERM", async () => {
      const proc = spawnDuplex(
        "node",
        node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'),
        { cwd: process.cwd(), timeoutMs: 3000, graceMs: 250 },
      );

      const exit = await proc.exited;

      assert.equal(exit.timedOut, true);
      assert.equal(exit.signal, "SIGKILL");
    });

    test("an abort signal terminates the process and is distinguishable from a timeout", async () => {
      const controller = new AbortController();
      const proc = spawnDuplex("node", node("setInterval(() => {}, 1000)"), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        signal: controller.signal,
      });

      proc.stdin.write("\n");
      controller.abort();
      const exit = await proc.exited;

      assert.equal(exit.aborted, true);
      assert.equal(exit.timedOut, false);
      assert.equal(exit.signal, "SIGTERM");
    });

    test("an already-aborted signal kills the process without waiting for the timeout", async () => {
      const proc = spawnDuplex("node", node("setInterval(() => {}, 1000)"), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
      });

      assert.equal((await proc.exited).aborted, true);
    });

    test("kill() resolves once the process is gone", async () => {
      const proc = spawnDuplex("node", node("setInterval(() => {}, 1000)"), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      });

      await proc.kill();
      const exit = await proc.exited;

      assert.equal(exit.signal, "SIGTERM");
      assert.equal(exit.timedOut, false);
      assert.equal(exit.aborted, false);
    });

    test("kill() is idempotent, including after a natural exit", async () => {
      const proc = spawnDuplex("node", node("process.exit(0)"), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      });

      await proc.exited;
      await proc.kill();
      await proc.kill();

      assert.equal((await proc.exited).code, 0);
    });

    test("two concurrent kill() calls both resolve", async () => {
      const proc = spawnDuplex("node", node("setInterval(() => {}, 1000)"), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      });

      await Promise.all([proc.kill(), proc.kill()]);

      assert.equal((await proc.exited).signal, "SIGTERM");
    });
  });

  describe("output is bounded", () => {
    // Defect 8's lesson, one process kind over: a session lives for hours, so the
    // stderr of a chatty agent is the thing that eats the heap.
    test("ring-buffers stderr rather than accumulating it", async () => {
      const proc = spawnDuplex(
        "node",
        node('for (let i = 0; i < 20000; i++) process.stderr.write("noisy line\\n")'),
        { cwd: process.cwd(), timeoutMs: 30_000, maxStderrBytes: 1024 },
      );

      const exit = await proc.exited;

      assert.ok(exit.stderrTail.length < 1200, `got ${exit.stderrTail.length} bytes`);
      assert.match(exit.stderrTail, /bytes dropped/);
      assert.ok(exit.stderrDropped > 0);
    });

    test("keeps stderr for the exit result, which is where the transport reads it", async () => {
      const proc = spawnDuplex("node", node('process.stderr.write("warned")'), {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      assert.equal((await proc.exited).stderrTail, "warned");
    });

    // stdout is the JSON-RPC channel: it belongs to the reader, and buffering it
    // here would both duplicate it and cap the thing the protocol runs on.
    test("does not retain stdout — the exit result has no copy of it", async () => {
      const proc = spawnDuplex("node", node('process.stdout.write("rpc frame")'), {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      const seen = await waitForOutput(proc.stdout, /rpc frame/);
      const exit = await proc.exited;

      assert.equal(seen, "rpc frame");
      assert.equal(Object.hasOwn(exit, "stdout"), false);
    });
  });

  // §2a rule 5: a missing agent binary names the binary, not an errno.
  test("a missing binary fails with a message naming it", async () => {
    const proc = spawnDuplex("definitely-not-installed-xyz", [], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    const err = await proc.exited.catch((e: unknown) => e);

    assert.ok(err instanceof ProcessStartError);
    assert.match(err.message, /definitely-not-installed-xyz not found on PATH/);
    assert.equal(err.failure, "transport");
  });

  test("kill() after a failed spawn resolves rather than hanging", async () => {
    const proc = spawnDuplex("definitely-not-installed-xyz", [], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    await proc.exited.catch(() => undefined);
    await proc.kill();
  });
});
