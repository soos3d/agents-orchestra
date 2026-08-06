// Defect 9: SIGINT orphaned every running subprocess with no checkpoint and no
// resume. Graceful drain is the right answer to Ctrl-C; panic (§10) is the answer to
// a worker on the wrong page in your bank, and they are deliberately not the same
// control.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { installShutdown, resumeCommand } from "./shutdown.js";

/** A stand-in for `process`, so a test never installs a real signal handler. */
function fakeProcess() {
  const emitter = new EventEmitter();
  return {
    target: emitter as unknown as Pick<NodeJS.Process, "on" | "off">,
    signal: (name: string) => emitter.emit(name),
    listenerCount: (name: string) => emitter.listenerCount(name),
  };
}

interface Harness {
  messages: string[];
  exits: number[];
  drains: string[];
}

function install(fake: ReturnType<typeof fakeProcess>, drain?: () => Promise<void>) {
  const state: Harness = { messages: [], exits: [], drains: [] };
  const handle = installShutdown({
    missionId: "m1",
    process: fake.target,
    onMessage: (message) => state.messages.push(message),
    exit: (code) => state.exits.push(code),
    drain: async (signal) => {
      state.drains.push(signal);
      await drain?.();
    },
  });
  return { handle, state };
}

describe("installShutdown", () => {
  test("drains in-flight work rather than exiting immediately", async () => {
    const fake = fakeProcess();
    const { handle, state } = install(fake);

    fake.signal("SIGINT");
    await handle.whenDone();

    assert.deepEqual(state.drains, ["SIGINT"]);
    assert.deepEqual(state.exits, [0]);
    handle.dispose();
  });

  test("prints the exact command to pick the mission back up", async () => {
    const fake = fakeProcess();
    const { handle, state } = install(fake);

    fake.signal("SIGINT");
    await handle.whenDone();

    assert.ok(state.messages.some((m) => m.includes(resumeCommand("m1"))));
    handle.dispose();
  });

  test("aborts the signal so running workers are told to stop", async () => {
    const fake = fakeProcess();
    const { handle } = install(fake);
    assert.equal(handle.signal.aborted, false);

    fake.signal("SIGTERM");
    await handle.whenDone();

    assert.equal(handle.signal.aborted, true);
    handle.dispose();
  });

  // A second Ctrl-C means the human wants out now, and pretending otherwise is how a
  // hung drain becomes an unkillable process.
  test("a second signal stops asking nicely", async () => {
    const fake = fakeProcess();
    const { handle, state } = install(fake, () => new Promise(() => {}));

    fake.signal("SIGINT");
    fake.signal("SIGINT");

    assert.deepEqual(state.exits, [130]);
    assert.ok(state.messages.some((m) => /Second SIGINT/.test(m)));
    handle.dispose();
  });

  test("drains once however many signals arrive", async () => {
    const fake = fakeProcess();
    const { handle, state } = install(fake, () => new Promise(() => {}));

    fake.signal("SIGINT");
    fake.signal("SIGTERM");
    fake.signal("SIGINT");

    assert.deepEqual(state.drains, ["SIGINT"]);
    handle.dispose();
  });

  test("handles SIGTERM as well as SIGINT", async () => {
    const fake = fakeProcess();
    const { handle, state } = install(fake);

    fake.signal("SIGTERM");
    await handle.whenDone();

    assert.deepEqual(state.drains, ["SIGTERM"]);
    handle.dispose();
  });

  test("dispose removes the listeners it installed", () => {
    const fake = fakeProcess();
    const { handle } = install(fake);
    assert.equal(fake.listenerCount("SIGINT"), 1);

    handle.dispose();

    assert.equal(fake.listenerCount("SIGINT"), 0);
  });
});
