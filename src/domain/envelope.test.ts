// The envelope is the ceiling a synthesized agent cannot widen, so these tests are
// written adversarially: the cases that matter are the ones where a plausible
// request should still be refused.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contains, describeViolations, envelopeSchema, violations } from "./envelope.js";
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
      contains(envelope, {
        toolClasses: ["fs.read"],
        domains: ["xero.com"],
        fsPaths: ["/repo/src/routes/health.ts"],
      }),
      true,
    );
  });

  test("refuses a tool class that was never granted", () => {
    assert.deepEqual(violations(envelope, { toolClasses: ["browser.commit"] }), [
      { field: "toolClasses", requested: "browser.commit" },
    ]);
  });

  test("refuses a host that is not on the allowlist", () => {
    assert.equal(contains(envelope, { domains: ["evil.example"] }), false);
  });

  // An allowlist that accepts patterns eventually contains one too broad to mean
  // anything, approved by a human who read it as specific.
  test("refuses a wildcard even when it would match an allowed host", () => {
    assert.equal(contains(envelope, { domains: ["*.xero.com"] }), false);
    assert.equal(contains(envelope, { domains: ["*"] }), false);
  });

  test("refuses a path outside the granted roots", () => {
    assert.equal(contains(envelope, { fsPaths: ["/etc/passwd"] }), false);
  });

  // The classic prefix bug: /repo/srcret is not inside /repo/src.
  test("does not treat a sibling with a shared prefix as inside a root", () => {
    assert.equal(contains(envelope, { fsPaths: ["/repo/srcret/keys.json"] }), false);
  });

  test("refuses a path that escapes a root by traversal", () => {
    assert.equal(contains(envelope, { fsPaths: ["/repo/src/../../etc/passwd"] }), false);
  });

  test("admits an environment variable the envelope names", () => {
    assert.equal(contains(envelope, { env: ["XERO_TOKEN"] }), true);
  });

  // The actual leak shape (defect 42): the variable is sitting in `process.env` and
  // the spec asked for it by name. Whether the machine has it is not the question.
  test("refuses an environment variable the envelope never named", () => {
    assert.deepEqual(violations(envelope, { env: ["AWS_SECRET_ACCESS_KEY"] }), [
      { field: "env", requested: "AWS_SECRET_ACCESS_KEY" },
    ]);
  });

  test("an envelope granting no variables refuses every one of them", () => {
    assert.equal(contains(anEnvelope({ env: [] }), { env: ["HOME"] }), false);
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

  test("refuses network access when the envelope grants none", () => {
    assert.equal(contains(anEnvelope({ network: "none" }), { network: "allowlist" }), false);
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
