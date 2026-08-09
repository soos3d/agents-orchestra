// The carrier-independent trust core (§10, §17): a channel delivers, it never
// decides.
//
// Every inbox item that leaves the machine leaves with a single-use nonce Fable
// issued and holds; every inbound reply is validated here, in-process, against that
// nonce and the one sender identity bound at configuration time. The design premise
// is a hostile carrier — the adopted channel's own pairing check has a 2026 CVE, and
// §17's row assumes full compromise: a forged message must be able to *say*
// anything and *approve* nothing. That is why consumption is a property of this
// store rather than anything the carrier promises, and why the verdicts are a
// closed union a caller has to handle rather than a boolean it could shortcut.
export interface BoundIdentity {
  /** Which carrier this identity means something on — "telegram", "openclaw". */
  carrier: string;
  /** The one sender allowed to resolve anything. Recorded at configuration, checked
   *  on every message; there is no multi-approver mode (§17). */
  senderId: string;
  boundAt: string;
}

export interface IssuedNonce {
  nonce: string;
  /** The inbox item this nonce can resolve, and the only one. */
  itemId: string;
  issuedAt: string;
  expiresAt: string;
}

export type Verdict =
  | { kind: "approved"; itemId: string }
  /** The same valid nonce, a second time. The first use resolved it; a forwarded or
   *  replayed message must not resolve anything again (§17). */
  | { kind: "replayed"; itemId: string }
  /** A valid-looking reply from the wrong identity. The caller emits
   *  `envelope_violation` and notifies the bound user — being told someone tried is
   *  part of the mitigation, not a courtesy. */
  | { kind: "wrong_sender"; senderId: string }
  | { kind: "unknown_nonce" }
  | { kind: "expired"; itemId: string };

export interface Trust {
  issue(itemId: string, now: Date): IssuedNonce;
  validate(reply: { nonce: string; senderId: string }, now: Date): Verdict;
}

export interface TrustOptions {
  /** A nonce outlives neither its item nor a working day. */
  ttlMs?: number;
  /** Injected for determinism in tests; the default is crypto-strength. */
  newNonce?(): string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000;

export function createTrust(identity: BoundIdentity, options: TrustOptions = {}): Trust {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const newNonce =
    options.newNonce ??
    (() => globalThis.crypto.getRandomValues(new Uint8Array(16)).reduce(
      (hex, byte) => hex + byte.toString(16).padStart(2, "0"),
      "",
    ));

  const issued = new Map<string, IssuedNonce>();
  const used = new Set<string>();

  return {
    issue(itemId, now) {
      const record: IssuedNonce = {
        nonce: newNonce(),
        itemId,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      issued.set(record.nonce, record);
      return record;
    },

    validate(reply, now) {
      // Sender first: a wrong identity is a report-worthy event even when the nonce
      // is garbage, and checking the nonce first would tell an attacker which
      // nonces are live by the shape of the refusal.
      if (reply.senderId !== identity.senderId) {
        return { kind: "wrong_sender", senderId: reply.senderId };
      }

      const record = issued.get(reply.nonce);
      if (!record) return { kind: "unknown_nonce" };
      if (used.has(reply.nonce)) return { kind: "replayed", itemId: record.itemId };
      if (now.toISOString() > record.expiresAt) return { kind: "expired", itemId: record.itemId };

      used.add(reply.nonce);
      return { kind: "approved", itemId: record.itemId };
    },
  };
}
