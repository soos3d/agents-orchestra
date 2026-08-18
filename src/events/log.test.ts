// The event log is the source of truth, so the failure modes that matter are the
// ones that make a replay wrong without saying so: a gap in the sequence, a
// silently dropped line, a truncated write, and a schema that moved underneath it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { createEventLog, LogCorruptionError } from "./log.js";
import { fixedClock, missionCreated } from "../testing/fixtures.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-log-"));
let dir: string;
let caseNo = 0;
const warnings: string[] = [];

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`);
  warnings.length = 0;
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const openLog = () =>
  createEventLog(dir, { now: fixedClock(), onWarn: (m) => warnings.push(m) });

const logFile = () => path.join(dir, "events.jsonl");

const writeLines = (lines: string[]) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logFile(), lines.map((l) => `${l}\n`).join(""));
};

describe("createEventLog", () => {
  test("a fresh log reads as empty rather than failing", () => {
    assert.deepEqual(openLog().read(), []);
  });

  test("assigns gapless seq starting at 1", () => {
    const log = openLog();

    log.append(missionCreated());
    log.append({ type: "round_started", missionId: "m1", actor: "orchestrator", round: 1 });

    assert.deepEqual(
      log.read().map((e) => e.seq),
      [1, 2],
    );
  });

  test("continues the sequence across process restarts", () => {
    openLog().append(missionCreated());

    const reopened = openLog();
    const event = reopened.append({
      type: "round_started",
      missionId: "m1",
      actor: "orchestrator",
      round: 1,
    });

    assert.equal(event.seq, 2);
  });

  // The whole point of allocating seq from an in-memory counter is that no `await`
  // can land between reading it and writing the line. If append ever becomes async,
  // two parallel dispatches can interleave and one wins the seq.
  test("the append path is synchronous, which is what makes seq gapless", () => {
    const log = openLog();

    assert.equal(log.append.constructor.name, "Function");
    assert.notEqual(log.append.constructor.name, "AsyncFunction");
  });

  test("refuses to write a malformed event rather than storing corruption", () => {
    const log = openLog();

    assert.throws(
      () => log.append({ type: "round_started", missionId: "", actor: "orchestrator", round: 1 }),
      /Refusing to log a malformed 'round_started' event/,
    );
    assert.equal(fs.existsSync(logFile()), false);
  });

  describe("replay", () => {
    test("a gap in seq raises instead of returning what it could read", () => {
      const log = openLog();
      log.append(missionCreated());
      log.append({ type: "round_started", missionId: "m1", actor: "orchestrator", round: 1 });
      log.append({ type: "round_started", missionId: "m1", actor: "orchestrator", round: 2 });

      const kept = fs
        .readFileSync(logFile(), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      writeLines([kept[0], kept[2]]); // drop seq 2

      assert.throws(() => openLog().read(), (err: unknown) => {
        assert.ok(err instanceof LogCorruptionError);
        assert.match((err as Error).message, /has seq 3, expected 2/);
        return true;
      });
    });

    test("an unknown event type is skipped with a warning, not a failure", () => {
      const log = openLog();
      log.append(missionCreated());
      const first = fs.readFileSync(logFile(), "utf8").trim();
      writeLines([
        first,
        JSON.stringify({
          v: 1,
          seq: 2,
          at: "2026-07-25T10:00:01.000Z",
          missionId: "m1",
          actor: "runtime",
          type: "invented_by_a_newer_build",
        }),
      ]);

      const events = openLog().read();

      assert.equal(events.length, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /invented_by_a_newer_build/);
    });

    // Forward compatibility is not corruption; a changed meaning is.
    test("an unknown schema version is fatal", () => {
      writeLines([
        JSON.stringify({ v: 2, seq: 1, at: "x", missionId: "m1", actor: "human", type: "panic" }),
      ]);

      assert.throws(() => openLog().read(), /schema version 2/);
    });

    test("a known event type with a malformed payload is fatal", () => {
      writeLines([
        JSON.stringify({
          v: 1,
          seq: 1,
          at: "2026-07-25T10:00:00.000Z",
          missionId: "m1",
          actor: "orchestrator",
          type: "round_started",
          round: "not a number",
        }),
      ]);

      assert.throws(() => openLog().read(), /malformed 'round_started' event/);
    });

    test("a truncated final line is fatal rather than silently dropped", () => {
      const log = openLog();
      log.append(missionCreated());
      const good = fs.readFileSync(logFile(), "utf8").trim();
      fs.writeFileSync(logFile(), `${good}\n{"v":1,"seq":2,"at":"x"`);

      assert.throws(() => openLog().read(), /is not valid JSON/);
    });

    test("a corrupt log cannot be appended to", () => {
      writeLines(["{ not json"]);

      assert.throws(
        () => openLog().append(missionCreated()),
        /is not valid JSON/,
      );
    });
  });

  test("keeps the log owner-only, since it quotes real business data", () => {
    openLog().append(missionCreated());

    const mode = fs.statSync(logFile()).mode & 0o777;

    assert.equal(mode, 0o600);
  });
});
