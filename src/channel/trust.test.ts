// The three adversarial Phase 6 milestones, as unit tests — no carrier required,
// which is the point: a forwarded approval is rejected, a replayed approval
// approves once, and a forged message from a compromised carrier can deliver but
// never approve. If these hold here, they hold for every carrier, including one
// that is lying.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTrust, type BoundIdentity } from "./trust.js";

const davide: BoundIdentity = { carrier: "test", senderId: "davide-123", boundAt: "2026-08-01T00:00:00Z" };
const at = (iso: string) => new Date(iso);
const now = at("2026-08-09T10:00:00Z");

const trust = () =>
  createTrust(davide, { newNonce: (() => { let n = 0; return () => `nonce-${++n}`; })() });

describe("createTrust", () => {
  test("the bound sender with a live nonce approves, once", () => {
    const t = trust();
    const { nonce } = t.issue("q1", now);

    assert.deepEqual(t.validate({ nonce, senderId: "davide-123" }, now), {
      kind: "approved",
      itemId: "q1",
    });
  });

  test("a forwarded approval — right nonce, wrong sender — is rejected and reported", () => {
    const t = trust();
    const { nonce } = t.issue("q1", now);

    const verdict = t.validate({ nonce, senderId: "mallory-999" }, now);

    assert.deepEqual(verdict, { kind: "wrong_sender", senderId: "mallory-999" });
    // And the nonce was not consumed by the attempt: the real approver still can.
    assert.equal(t.validate({ nonce, senderId: "davide-123" }, now).kind, "approved");
  });

  test("a replayed approval — the same valid message twice — approves once", () => {
    const t = trust();
    const { nonce } = t.issue("q1", now);

    assert.equal(t.validate({ nonce, senderId: "davide-123" }, now).kind, "approved");
    assert.deepEqual(t.validate({ nonce, senderId: "davide-123" }, now), {
      kind: "replayed",
      itemId: "q1",
    });
  });

  test("a forged nonce from a compromised carrier approves nothing", () => {
    const t = trust();
    t.issue("q1", now);

    assert.equal(t.validate({ nonce: "invented-by-the-carrier", senderId: "davide-123" }, now).kind, "unknown_nonce");
  });

  test("an expired nonce is dead even for the bound sender", () => {
    const t = createTrust(davide, { ttlMs: 60_000, newNonce: () => "n1" });
    t.issue("q1", now);

    assert.equal(t.validate({ nonce: "n1", senderId: "davide-123" }, at("2026-08-09T10:02:00Z")).kind, "expired");
  });

  test("each nonce resolves its own item and no other", () => {
    const t = trust();
    const first = t.issue("q1", now);
    const second = t.issue("q2", now);

    assert.deepEqual(t.validate({ nonce: second.nonce, senderId: "davide-123" }, now), {
      kind: "approved",
      itemId: "q2",
    });
    assert.deepEqual(t.validate({ nonce: first.nonce, senderId: "davide-123" }, now), {
      kind: "approved",
      itemId: "q1",
    });
  });

  test("the default nonce is not guessable from its neighbours", () => {
    const t = createTrust(davide);
    const a = t.issue("q1", now).nonce;
    const b = t.issue("q2", now).nonce;

    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
  });
});
