// Leases are checked twice because a declaration is a promise and not a guarantee:
// once at dispatch against in-flight leases, once after the worker returns against
// what it actually touched.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectEscape, globsOverlap, requestLease } from "./leases.js";

const held = [{ taskId: "t1", owns: ["src/routes/health.ts", "test/health.test.ts"] }];

describe("requestLease", () => {
  test("grants a lease on files nobody holds", () => {
    assert.deepEqual(requestLease(held, "t2", ["src/db/pool.ts"]), { granted: true });
  });

  // The §8 example: `src/routes/**` overlaps t1's lease on src/routes/health.ts.
  test("rejects a lease whose glob swallows a held file", () => {
    const decision = requestLease(held, "t2", ["src/routes/**"]);

    assert.equal(decision.granted, false);
    assert.equal(decision.granted === false && decision.conflictsWith, "t1");
  });

  test("rejects a lease on the exact same file", () => {
    assert.equal(requestLease(held, "t2", ["src/routes/health.ts"]).granted, false);
  });

  test("the message names both the overlap and what to do about it", () => {
    const decision = requestLease(held, "t2", ["src/routes/**"]);

    assert.match(
      decision.granted === false ? decision.message : "",
      /overlaps t1's lease.*Narrow one of the tasks/s,
    );
  });

  // A retried task re-requesting its own lease is not a conflict with itself.
  test("ignores the requesting task's own lease", () => {
    assert.deepEqual(requestLease(held, "t1", ["src/routes/health.ts"]), { granted: true });
  });

  test("grants against an empty set", () => {
    assert.deepEqual(requestLease([], "t1", ["src/**"]), { granted: true });
  });
});

describe("globsOverlap", () => {
  test("detects a directory glob containing a file", () => {
    assert.equal(globsOverlap(["src/**"], ["src/routes/health.ts"]), true);
  });

  test("detects the same overlap in either order", () => {
    assert.equal(globsOverlap(["src/routes/health.ts"], ["src/**"]), true);
  });

  test("separates sibling directories", () => {
    assert.equal(globsOverlap(["src/routes/**"], ["src/db/**"]), false);
  });

  // The prefix trap: `src/routes` and `src/routers` share five characters and
  // nothing else.
  test("does not confuse a shared prefix with containment", () => {
    assert.equal(globsOverlap(["src/routes/**"], ["src/routers/index.ts"]), false);
  });

  test("detects two extension globs in the same directory", () => {
    assert.equal(globsOverlap(["src/*.ts"], ["src/index.ts"]), true);
  });
});

describe("detectEscape", () => {
  test("passes a worker that stayed inside its lease", () => {
    assert.deepEqual(
      detectEscape(["src/routes/**"], ["src/routes/health.ts", "src/routes/index.ts"]),
      { escaped: false },
    );
  });

  test("catches a worker that wrote outside its lease", () => {
    const result = detectEscape(["src/routes/**"], ["src/routes/health.ts", "package.json"]);

    assert.equal(result.escaped, true);
    assert.deepEqual(result.escaped ? result.touched : [], ["package.json"]);
  });

  // §8: an escape means the plan was wrong, so it goes back to the outer loop rather
  // than back to the same worker. The message has to say that, or somebody retries.
  test("the message says the task is not retried", () => {
    const result = detectEscape(["src/**"], ["/etc/hosts"]);

    assert.match(result.escaped ? result.message : "", /fails without retry/);
  });

  test("a worker that touched nothing has not escaped", () => {
    assert.deepEqual(detectEscape(["src/**"], []), { escaped: false });
  });
});
