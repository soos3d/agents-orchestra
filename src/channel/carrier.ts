// The carrier interface: everything a phone channel is allowed to be (§0, §2, §10).
//
// Deliberately this small — publish a card, hand back replies — because the
// interface is the argument for adopting a channel at arm's length at all. A
// carrier never sees Fable state, artifacts, credentials, or an unredacted
// screenshot (`cards.ts` enforces what a card may carry), and nothing it returns is
// trusted until `trust.ts` has validated the nonce and the sender. Implementations
// are optional dependencies loaded only when configured, so a mission with no
// mirror pulls none of this (§14); losing the mirror degrades usability and never
// correctness.
import { type GateCard } from "./cards.js";

export interface CarrierReply {
  nonce: string;
  /** The carrier's stable sender id, checked against the bound identity. A carrier
   *  that cannot produce one cannot resolve anything — §17's nonce stands alone
   *  only where the spike proved it has to. */
  senderId: string;
  /** Free text for a question's answer; ignored for approve/deny items. */
  text?: string;
  approved?: boolean;
}

export interface Carrier {
  /** "telegram", "openclaw" — matches BoundIdentity.carrier. */
  id: string;
  publish(card: GateCard): Promise<void>;
  onReply(handler: (reply: CarrierReply) => void): void;
  close?(): Promise<void>;
}
