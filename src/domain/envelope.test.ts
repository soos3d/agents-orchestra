// The envelope is the ceiling a synthesized agent cannot widen, so these tests are
// written adversarially: the cases that matter are the ones where a plausible
// request should still be refused.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeViolations, envelopeSchema, violations } from "./envelope.js";
import { anEnvelope } from "../testing/fixtures.js";

const envelope = anEnvelope({
  toolClasses: ["fs.read", "browser.read"],
  domains: ["xero.com", "ramp.com"],
  fsRoots: ["/repo/src"],
  env: ["XERO_TOKEN"],
  network: "allowlist",
});

describe("envelope", () => {
  test("admits a request drawn entirely from the envelope", () => {
    assert.equal(
      violations(envelope, {
        toolClasses: ["fs.read"],
        domains: ["xero.com"],
        fsPaths: ["/repo/src/routes/health.ts"],
      }).length === 0,
      true,
    );
  });

  test("refuses a tool class that was never granted", () => {
    assert.deepEqual(violations(envelope, { toolClasses: ["browser.commit"] }), [
      { field: "toolClasses", requested: "browser.commit" },
    ]);
  });

  test("refuses a host that is not on the allowlist", () => {
    assert.equal(violations(envelope, { domains: ["evil.example"] }).length === 0, false);
  });

  // An allowlist that accepts patterns eventually contains one too broad to mean
  // anything, approved by a human who read it as specific.
  test("refuses a wildcard even when it would match an allowed host", () => {
    assert.equal(violations(envelope, { domains: ["*.xero.com"] }).length === 0, false);
    assert.equal(violations(envelope, { domains: ["*"] }).length === 0, false);
  });

  test("refuses a path outside the granted roots", () => {
    assert.equal(violations(envelope, { fsPaths: ["/etc/passwd"] }).length === 0, false);
  });

  // The classic prefix bug: /repo/srcret is not inside /repo/src.
  test("does not treat a sibling with a shared prefix as inside a root", () => {
    assert.equal(violations(envelope, { fsPaths: ["/repo/srcret/keys.json"] }).length === 0, false);
  });

  test("refuses a path that escapes a root by traversal", () => {
    assert.equal(violations(envelope, { fsPaths: ["/repo/src/../../etc/passwd"] }).length === 0, false);
  });

  test("admits an environment variable the envelope names", () => {
    assert.equal(violations(envelope, { env: ["XERO_TOKEN"] }).length === 0, true);
  });

  // The actual leak shape (defect 42): the variable is sitting in `process.env` and
  // the spec asked for it by name. Whether the machine has it is not the question.
  test("refuses an environment variable the envelope never named", () => {
    assert.deepEqual(violations(envelope, { env: ["AWS_SECRET_ACCESS_KEY"] }), [
      { field: "env", requested: "AWS_SECRET_ACCESS_KEY" },
    ]);
  });

  test("an envelope granting no variables refuses every one of them", () => {
    assert.equal(violations(anEnvelope({ env: [] }), { env: ["HOME"] }).length === 0, false);
  });

  // Every `mission_created` written before the field existed embeds an envelope
  // without it, and those logs still have to fold.
  test("an envelope recorded before env existed parses as granting none", () => {
    const legacy = {
      toolClasses: ["fs.read"],
      domains: [],
      fsRoots: ["/repo"],
      network: "none",
      maxSpend: { wallMs: 1000 },
      approval: "local",
    };
    const parsed = envelopeSchema.safeParse(legacy);

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.env, []);
  });

  // PLAN-NEXT 3.2, and the one check that runs the other way: every rule above catches a
  // request for *more* than was granted, this one catches a request for less protection
  // than was imposed. Getting the direction wrong would let a spec out of the sandbox
  // while the suite stayed green.
  test("refuses a spec that asks to run outside a mission's container", () => {
    const contained = anEnvelope({ containment: "container" });

    assert.equal(violations(contained, { containment: "none" }).length === 0, false);
    assert.equal(violations(contained, { containment: "container" }).length === 0, true);
    // Absent is not a request: almost every spec omits the field and inherits.
    assert.equal(violations(contained, {}).length === 0, true);
  });

  test("a mission that contains nothing is not widened by a spec that says so", () => {
    // The reverse direction is not a violation — there is nothing to be let out of, and
    // the runtime is the envelope's to decide either way.
    assert.equal(violations(anEnvelope({ containment: "none" }), { containment: "container" }).length === 0, true);
  });

  test("an envelope written before containment existed folds as uncontained", () => {
    const legacy = {
      toolClasses: [],
      domains: [],
      fsRoots: ["/repo"],
      network: "none",
      maxSpend: { wallMs: 1000 },
      approval: "local",
    };
    const parsed = envelopeSchema.safeParse(legacy);

    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.containment, "none");
  });

  test("refuses network access when the envelope grants none", () => {
    assert.equal(violations(anEnvelope({ network: "none" }), { network: "allowlist" }).length === 0, false);
  });

  // The question that reaches the human should name the whole gap, not one item at
  // a time across three round trips.
  test("reports every violation at once", () => {
    const found = violations(envelope, {
      toolClasses: ["browser.commit"],
      domains: ["evil.example"],
      fsPaths: ["/etc/passwd"],
    });

    assert.equal(found.length, 3);
    assert.match(describeViolations(found), /browser\.commit/);
  });
});
