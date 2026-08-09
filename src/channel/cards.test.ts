// The never-mirrored rules (§17), tested where they are enforced: a
// credential-class gate has no card at all, and no card of any kind carries a
// screenshot path — the caption names the action and the pixels stay on the
// machine. Structural as well as asserted: GateCard has no field to put an image
// in, and these tests are the tripwire against someone adding one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stamp } from "../testing/fixtures.js";
import { missionCreated } from "../testing/fixtures.js";
import { type Event, type EventInput } from "../events/schema.js";
import { buildCard } from "./cards.js";

const eventOf = (input: EventInput): Event => stamp([missionCreated(), input])[1]!;
const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;

describe("buildCard", () => {
  test("a question becomes a self-contained card", () => {
    const built = buildCard(
      eventOf({ ...orchestrator, taskId: "t1", type: "question_asked", questionId: "q1", question: "Which account?", blocks: ["t1"] }),
      "n1",
    );

    assert.ok(built.ok);
    assert.deepEqual(built.card, {
      itemId: "q1",
      kind: "question",
      caption: "Which account?",
      nonce: "n1",
      missionId: "m1",
    });
  });

  test("a credential-class gate is refused — never mirrored, whatever the carrier", () => {
    const built = buildCard(
      eventOf({
        ...orchestrator,
        taskId: "t1",
        type: "gate_requested",
        gateId: "g1",
        actionClass: "credential",
        description: "Log in to the bank",
        screenshotPath: ".orchestra/shots/g1.png",
      }),
      "n1",
    );

    assert.equal(built.ok, false);
    assert.ok(!built.ok && /never mirrored/.test(built.reason));
  });

  test("a commit gate's card names the action and leaves the screenshot behind", () => {
    const built = buildCard(
      eventOf({
        ...orchestrator,
        taskId: "t1",
        type: "gate_requested",
        gateId: "g1",
        actionClass: "commit",
        description: "Submit expense £240",
        screenshotPath: ".orchestra/shots/g1.png",
      }),
      "n1",
    );

    assert.ok(built.ok);
    assert.match(built.card.caption, /Submit expense £240/);
    assert.equal(JSON.stringify(built.card).includes("g1.png"), false);
  });

  test("an event that is not an inbox item has no card", () => {
    const built = buildCard(eventOf({ ...orchestrator, type: "round_started", round: 1 }), "n1");
    assert.equal(built.ok, false);
  });
});
