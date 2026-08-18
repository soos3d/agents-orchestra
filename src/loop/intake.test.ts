// The failure this file exists to catch: a mission that parks forever on a question
// nobody can answer.
//
// Intake opens an inbox item per question and the mission halts while one is open, so
// every question asked has to be closed by something. A model that asks four, or that
// asks two questions under one id, or a human who skips one — each leaves an item
// open, and an open item is a mission that never runs. The cap, the dedupe, and the
// close-everything rule are all the same bug from different directions.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { anIntakeQuestion, missionCreated, stamp } from "../testing/fixtures.js";
import { type IntakeQuestion } from "./calls.js";
import { type HumanPort, type IntakeAnswer } from "./human.js";
import { answersAsFacts, capQuestions, MAX_INTAKE_QUESTIONS, runIntake } from "./intake.js";
import { type MissionStore } from "./run.js";

function testStore(seed: readonly EventInput[] = [missionCreated()]) {
  const inputs = [...seed];
  const store: MissionStore & { inputs: EventInput[] } = {
    inputs,
    emit: (event) => {
      inputs.push(event);
    },
    state: () => fold(stamp(inputs)),
  };
  return store;
}

/** Answers whatever it is asked, in order, unless told to skip. */
function aHuman(answers: Record<string, string>): HumanPort & { asked: IntakeQuestion[] } {
  const asked: IntakeQuestion[] = [];
  return {
    asked,
    askIntake: async (questions) => {
      asked.push(...questions);
      return questions.flatMap((question): IntakeAnswer[] => {
        const answer = answers[question.id];
        return answer === undefined ? [] : [{ questionId: question.id, answer }];
      });
    },
    awaitSignoff: async () => ({ kind: "approve" }),
  };
}

const questions = (count: number): IntakeQuestion[] =>
  Array.from({ length: count }, (_, index) =>
    anIntakeQuestion({ id: `q${index + 1}`, question: `question ${index + 1}?` }),
  );

describe("capQuestions", () => {
  test("keeps the first three and reports what it dropped", () => {
    const { asked, dropped } = capQuestions(questions(5));

    assert.equal(asked.length, MAX_INTAKE_QUESTIONS);
    assert.deepEqual(
      asked.map((question) => question.id),
      ["q1", "q2", "q3"],
    );
    assert.equal(dropped.length, 2);
  });

  test("asks nothing when nothing is ambiguous, which is a good answer", () => {
    assert.deepEqual(capQuestions([]), { asked: [], dropped: [] });
  });

  // Two questions under one id would leave an inbox item that no answer can resolve,
  // because `intake_answered` resolves by id.
  test("drops a duplicate id rather than opening an item nothing can close", () => {
    const { asked, dropped } = capQuestions([
      anIntakeQuestion({ id: "q1", question: "first?" }),
      anIntakeQuestion({ id: "q1", question: "second, same id?" }),
    ]);

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.question, "first?");
    assert.equal(dropped.length, 1);
  });

  // The cap counts what gets asked. A duplicate consuming a slot would mean three
  // questions returned and two asked, which is the cap doing the wrong job.
  test("a duplicate does not consume one of the three slots", () => {
    const { asked } = capQuestions([
      anIntakeQuestion({ id: "q1" }),
      anIntakeQuestion({ id: "q1" }),
      anIntakeQuestion({ id: "q2" }),
      anIntakeQuestion({ id: "q3" }),
    ]);

    assert.deepEqual(
      asked.map((question) => question.id),
      ["q1", "q2", "q3"],
    );
  });
});

describe("answersAsFacts", () => {
  test("carries the question, because the answer alone means nothing later", () => {
    const asked = [anIntakeQuestion({ id: "q1", question: "Calendar June or fiscal?" })];
    const facts = answersAsFacts(asked, [{ questionId: "q1", answer: "calendar" }], []);

    assert.equal(facts.length, 1);
    assert.match(facts[0]!.text, /Calendar June or fiscal\? — calendar/);
  });

  test("ids continue from the facts already given, so nothing overwrites", () => {
    const existing = [{ id: "h1", text: "already stated", addedRound: 0 }];
    const facts = answersAsFacts(
      [anIntakeQuestion({ id: "q1" })],
      [{ questionId: "q1", answer: "yes" }],
      existing,
    );

    assert.equal(facts[0]?.id, "h2");
  });

  test("an unanswered question produces no fact rather than an empty one", () => {
    const facts = answersAsFacts(
      [anIntakeQuestion({ id: "q1" })],
      [{ questionId: "q1", answer: "   " }],
      [],
    );

    assert.deepEqual(facts, []);
  });
});

describe("runIntake", () => {
  const calls = (asked: IntakeQuestion[]) => ({ intake: async () => ({ questions: asked }) });

  test("asks at most three when the model wants five, and the cap is code", async () => {
    const store = testStore();
    const human = aHuman({ q1: "a", q2: "b", q3: "c", q4: "d", q5: "e" });

    await runIntake({ store, calls: calls(questions(5)), human });

    assert.equal(human.asked.length, MAX_INTAKE_QUESTIONS);
    const opened = store.inputs.filter((event) => event.type === "intake_question");
    assert.equal(opened.length, MAX_INTAKE_QUESTIONS);
  });

  test("warns about what it did not ask, so it is not silently dropped", async () => {
    const store = testStore();
    const warnings: string[] = [];

    await runIntake({
      store,
      calls: calls(questions(4)),
      human: aHuman({ q1: "a", q2: "b", q3: "c" }),
      onWarn: (message) => warnings.push(message),
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /question 4\?/);
  });

  // The mission halts while an inbox item is open, so a question the human declined to
  // answer would strand the run. §2b says an unasked question is worth a guess at
  // sign-off, not a blocker.
  test("closes every question it opened, including the one nobody answered", async () => {
    const store = testStore();

    await runIntake({ store, calls: calls(questions(3)), human: aHuman({ q1: "a", q3: "c" }) });

    const open = store.state().inbox.filter((item) => !item.resolvedAt);
    assert.deepEqual(open, []);
  });

  test("a port answering a question nobody asked cannot leave an item open", async () => {
    const store = testStore();
    const rogue: HumanPort = {
      askIntake: async () => [{ questionId: "q-not-asked", answer: "hello" }],
      awaitSignoff: async () => ({ kind: "approve" }),
    };

    await runIntake({ store, calls: calls(questions(2)), human: rogue });

    assert.deepEqual(
      store.state().inbox.filter((item) => !item.resolvedAt),
      [],
    );
  });

  test("asks nobody anything when the model returns no questions", async () => {
    const store = testStore();
    const human = aHuman({});

    const facts = await runIntake({ store, calls: calls([]), human });

    assert.deepEqual(facts, []);
    assert.equal(human.asked.length, 0);
    assert.equal(
      store.inputs.some((event) => event.type === "intake_question"),
      false,
    );
  });

  // The scan runs first precisely so the questions can be specific (§2b). If its
  // findings did not reach the call, intake would be asking blind and the whole
  // ordering would be pointless.
  test("hands the scan's findings to the call that writes the questions", async () => {
    const store = testStore([
      missionCreated(),
      {
        type: "ledger_revised",
        missionId: "m1",
        actor: "orchestrator",
        reason: "research",
        ledger: {
          ...fold(stamp([missionCreated()])).mission.ledger,
          factsVerified: [
            {
              id: "f1",
              text: "the repo has both npm test and make check",
              addedRound: 0,
              source: { kind: "research", ref: "package.json" },
              observedAt: "2026-07-25T10:00:00.000Z",
            },
          ],
        },
      } as EventInput,
    ]);

    let seen: unknown;
    await runIntake({
      store,
      calls: {
        intake: async (input) => {
          seen = input;
          return { questions: [] };
        },
      },
      human: aHuman({}),
    });

    assert.match(JSON.stringify(seen), /npm test and make check/);
  });
});
