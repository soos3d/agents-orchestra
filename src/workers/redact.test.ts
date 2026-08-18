// The failure this file exists to prevent has two halves and the second one is the
// dangerous one. A granted credential reaching an event or an evidence file is the
// obvious leak; a scrubber that rewrites text merely *resembling* a secret is the quiet
// one — it corrupts a worker's correct output, and the mission then fails a criterion
// while quoting mangled evidence nobody can trace back. Defects 34, 37, 38 and 44 were
// all that shape, so every test here is about exactness.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MIN_REDACTED_LENGTH, grantedSecrets, redact, withoutSecrets } from "./redact.js";

const secret = (name: string, value: string) => ({ name, value });

describe("redact", () => {
  test("replaces every occurrence of a granted value, naming the variable", () => {
    const text = "used sk_live_9d8f7a6b twice: sk_live_9d8f7a6b";

    assert.equal(
      redact(text, [secret("STRIPE_KEY", "sk_live_9d8f7a6b")]),
      "used [redacted:STRIPE_KEY] twice: [redacted:STRIPE_KEY]",
    );
  });

  test("leaves text that merely looks like a secret exactly as it was", () => {
    // Every one of these is the shape a heuristic would match and none is the value.
    const text = [
      "the docs say to export STRIPE_KEY=sk_live_xxxxxxxx",
      "sk_live_9d8f7a6c is a different key",
      "Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc",
      "AKIAIOSFODNN7EXAMPLE",
    ].join("\n");

    assert.equal(redact(text, [secret("STRIPE_KEY", "sk_live_9d8f7a6b")]), text);
  });

  test("no secrets is identity, including on text full of key-shaped strings", () => {
    const text = "sk_live_9d8f7a6b\nghp_0123456789abcdef";

    assert.equal(redact(text, []), text);
  });

  // `String.replace` would treat these as a pattern and as a substitution respectively.
  // A value containing `$&` re-inserts the match — which is the value — so the naive
  // implementation leaks exactly what it was asked to remove.
  test("a value carrying regex or replacement syntax is matched literally", () => {
    const dollar = secret("ODD", "pw$&$'$`x1");
    const dot = secret("DOT", "a.c.e.g.i.k");

    assert.equal(redact(`before ${dollar.value} after`, [dollar]), "before [redacted:ODD] after");
    assert.equal(redact("aXcXeXgXiXk", [dot]), "aXcXeXgXiXk");
    assert.equal(redact("a.c.e.g.i.k", [dot]), "[redacted:DOT]");
  });

  // An account id inside a token: scrubbing the short one first would leave
  // `sk_[redacted:ACCOUNT]xyz` behind — the long value gone but never matched, and its
  // remaining halves still on disk.
  test("a value containing another is scrubbed whole, longest first", () => {
    const out = redact("token sk_acct_12345678_xyz here", [
      secret("ACCOUNT", "acct_12345678"),
      secret("TOKEN", "sk_acct_12345678_xyz"),
    ]);

    assert.equal(out, "token [redacted:TOKEN] here");
  });

  test("a report stays parseable JSON after its embedded value is cut", () => {
    const raw = JSON.stringify({ outcome: "done", summary: "called with sk_live_9d8f7a6b" });

    const parsed = JSON.parse(redact(raw, [secret("STRIPE_KEY", "sk_live_9d8f7a6b")]));

    assert.equal(parsed.summary, "called with [redacted:STRIPE_KEY]");
  });
});

// The scanner's environment (PLAN-NEXT 7.3, from the stage's security review). A worker's
// environment is constructed from an allowlist; a scanner drives its own coding agent and
// needs the operator's environment to find its credentials, so what is decidable for it is
// what to withhold rather than what to allow.
describe("withoutSecrets", () => {
  test("removes every granted name and leaves the rest of the environment alone", () => {
    const env = withoutSecrets(
      { STRIPE_KEY: "sk_live_9d8f7a6b", PATH: "/usr/bin", HOME: "/home/x" },
      [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b" }],
    );

    assert.equal("STRIPE_KEY" in env, false);
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x" });
  });

  test("a mission that granted nothing gets the environment it was given", () => {
    const parent = { PATH: "/usr/bin" };

    assert.equal(withoutSecrets(parent, []), parent);
  });

  test("never mutates the environment it was handed", () => {
    const parent = { STRIPE_KEY: "sk_live_9d8f7a6b", PATH: "/usr/bin" };
    withoutSecrets(parent, [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b" }]);

    assert.equal(parent.STRIPE_KEY, "sk_live_9d8f7a6b");
  });
});

describe("grantedSecrets", () => {
  test("pairs each granted name with the value this machine holds", () => {
    const found = grantedSecrets(
      { STRIPE_KEY: "sk_live_9d8f7a6b", UNRELATED: "not-granted-value" },
      ["STRIPE_KEY"],
    );

    assert.deepEqual(found, [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b" }]);
  });

  test("a granted name the machine does not hold contributes nothing", () => {
    assert.deepEqual(grantedSecrets({}, ["STRIPE_KEY"]), []);
  });

  // The whole reason for the floor: `LOG_LEVEL=debug` granted would otherwise delete
  // the word "debug" from every report a worker writes.
  test("a value too short to be a credential is left out rather than scrubbed", () => {
    const short = "x".repeat(MIN_REDACTED_LENGTH - 1);

    assert.deepEqual(grantedSecrets({ LOG_LEVEL: short }, ["LOG_LEVEL"]), []);
    assert.equal(
      grantedSecrets({ LOG_LEVEL: "x".repeat(MIN_REDACTED_LENGTH) }, ["LOG_LEVEL"]).length,
      1,
    );
  });

  test("two names holding the same value scrub once rather than twice", () => {
    const found = grantedSecrets(
      { STRIPE_KEY: "sk_live_9d8f7a6b", STRIPE_SECRET: "sk_live_9d8f7a6b" },
      ["STRIPE_KEY", "STRIPE_SECRET"],
    );

    assert.equal(found.length, 1);
    assert.equal(redact("sk_live_9d8f7a6b", found), "[redacted:STRIPE_KEY]");
  });
});
