// The failure this file exists to catch: approving a plan by pressing Enter.
//
// Sign-off is the one blocking screen whose entire value is that somebody read it
// (§2b) — the error it catches, optimising correctly for the wrong outcome, is the
// one the loop cannot detect on its own, because every internal check afterwards
// reports success. A default-to-approve prompt gives that away for a keystroke, so
// the empty reply re-asks and nothing else here defaults either.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aCriterion, anEnvelope, aPlannedTask } from "../testing/fixtures.js";
import { type SignoffPresentation } from "../loop/human.js";
import { anIntakeQuestion } from "../testing/fixtures.js";
import { renderSignoff } from "./render.js";
import { createTerminalHuman, scriptedPrompter, type Prompter } from "./terminal.js";
import { type Io } from "./main.js";

const capture = (): Io & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) };
};

/** Records what it was asked, so a prompt that never happens is visible. */
function recording(answers: readonly string[]): Prompter & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers[index++];
    },
    close: () => {},
  };
}

const aPresentation = (patch: Partial<SignoffPresentation> = {}): SignoffPresentation => ({
  missionId: "m1",
  goal: "Add a /health endpoint",
  brief: "The repo has a router but no health route.",
  criteria: [aCriterion()],
  guesses: [
    { id: "g3", text: "June means the calendar month", addedRound: 0, confidence: "medium", basis: "the brief" },
  ],
  outOfScope: ["fixing mismatches"],
  envelope: anEnvelope(),
  plan: [aPlannedTask()],
  estimate: { taskCount: 1, tokens: 120_000, wallMs: 35 * 60_000, expectedGates: 2 },
  ...patch,
});

describe("the terminal sign-off", () => {
  test("approves on 'approve', and on the short forms a human actually types", async () => {
    for (const reply of ["approve", "a", "y", "yes", "  APPROVE  "]) {
      const human = createTerminalHuman(capture(), scriptedPrompter([reply]));
      assert.deepEqual(await human.awaitSignoff(aPresentation()), { kind: "approve" }, reply);
    }
  });

  // The whole point. An empty line is somebody leaning on Enter, not a decision.
  test("an empty reply re-asks instead of approving", async () => {
    const io = capture();
    const prompter = recording(["", "", "approve"]);

    const decision = await createTerminalHuman(io, prompter).awaitSignoff(aPresentation());

    assert.deepEqual(decision, { kind: "approve" });
    assert.equal(prompter.prompts.length, 3);
    assert.equal(io.lines.filter((line) => /Type 'approve'/.test(line)).length, 2);
  });

  // A closed pipe is not a person saying yes. Skipping sign-off is a decision made
  // with a flag (§17); inferring it from end-of-input would hand the guarantee away
  // to a shell redirect.
  test("end of input raises rather than approving", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([]));

    await assert.rejects(human.awaitSignoff(aPresentation()), /standard input ended/);
  });

  test("end of input after a blank line still raises, rather than looping forever", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([""]));

    await assert.rejects(human.awaitSignoff(aPresentation()), /--unattended --force/);
  });

  test("anything else is feedback, and revise is not a rejection", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter(["split task one in half"]));

    assert.deepEqual(await human.awaitSignoff(aPresentation()), {
      kind: "revise",
      feedback: "split task one in half",
    });
  });

  test("shows the criteria, the guesses, and the split estimate before asking", async () => {
    const io = capture();

    await createTerminalHuman(io, scriptedPrompter(["approve"])).awaitSignoff(aPresentation());

    const output = io.lines.join("\n");
    assert.match(output, /GUESSES/);
    assert.match(output, /June means the calendar month/);
    assert.match(output, /GET \/health returns 200/);
    assert.match(output, /~120k tokens measured, 1 CLI runs unmeasured/);
    assert.match(output, /OUT OF SCOPE/);
  });
});

describe("the terminal intake", () => {
  test("returns one answer per question answered", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter(["npm test", "calendar"]));

    const answers = await human.askIntake([
      anIntakeQuestion({ id: "q1" }),
      anIntakeQuestion({ id: "q2" }),
    ]);

    assert.deepEqual(answers, [
      { questionId: "q1", answer: "npm test" },
      { questionId: "q2", answer: "calendar" },
    ]);
  });

  // Enter skips. §2b: what goes unanswered becomes a labelled guess at sign-off,
  // which is cheaper than an interrogation — so skipping must be one keystroke.
  test("an empty answer is a skip, not a blank fact", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter(["", "  ", "yes"]));

    const answers = await human.askIntake([
      anIntakeQuestion({ id: "q1" }),
      anIntakeQuestion({ id: "q2" }),
      anIntakeQuestion({ id: "q3" }),
    ]);

    assert.deepEqual(answers, [{ questionId: "q3", answer: "yes" }]);
  });

  // With no input at all there is no one here, and these ports race: a terminal that
  // returned "no answers" would beat the dashboard to every question on a machine
  // with no tty, and the browser would never be asked.
  test("raises when the input ends before a single answer, so another surface can take it", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([]));

    await assert.rejects(human.askIntake([anIntakeQuestion({ id: "q1" })]));
  });

  test("stops asking when the input ends, and returns what it already has", async () => {
    const prompter = recording(["npm test"]);
    const human = createTerminalHuman(capture(), prompter);

    const answers = await human.askIntake([
      anIntakeQuestion({ id: "q1" }),
      anIntakeQuestion({ id: "q2" }),
      anIntakeQuestion({ id: "q3" }),
    ]);

    assert.deepEqual(answers, [{ questionId: "q1", answer: "npm test" }]);
    assert.equal(prompter.prompts.length, 2);
  });

  test("shows the options when the answer is a choice", async () => {
    const io = capture();

    await createTerminalHuman(io, scriptedPrompter(["npm test"])).askIntake([
      anIntakeQuestion({ id: "q1", options: ["npm test", "make check"] }),
    ]);

    assert.match(io.lines.join("\n"), /options: npm test \/ make check/);
  });
});

// §9.4: running out is a question, not a failure — twenty more minutes on a mission
// that is most of the way there beats abandoning three hours of paid work.
describe("the extension request", () => {
  const aRequest = {
    missionId: "m1",
    spentWallMs: 240 * 60_000,
    budget: { wallMs: 240 * 60_000 },
    unmetCriteria: ["c3"],
    extensionsUsed: 0,
  };

  test("adds the minutes asked for, on top of the existing budget", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter(["20"]));

    assert.deepEqual(await human.requestExtension!(aRequest), { wallMs: 260 * 60_000 });
  });

  test("shows what is still outstanding, which is the reason to say yes or no", async () => {
    const io = capture();

    await createTerminalHuman(io, scriptedPrompter(["20"])).requestExtension!(aRequest);

    const output = io.lines.join("\n");
    assert.match(output, /still outstanding: c3/);
    assert.match(output, /spent 240 min of 240/);
    assert.match(output, /extension 1 of 2/);
  });

  // Enter declines, and declining abandons with the artifacts intact. Nothing here
  // may buy time by default — that is the shape §9.4 guards against.
  test("Enter declines rather than guessing an amount", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([""]));

    assert.equal(await human.requestExtension!(aRequest), undefined);
  });

  test("end of input declines, so silence never extends a budget", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([]));

    assert.equal(await human.requestExtension!(aRequest), undefined);
  });

  test("nonsense declines rather than parsing to NaN minutes", async () => {
    for (const reply of ["soon", "-5", "0"]) {
      const human = createTerminalHuman(capture(), scriptedPrompter([reply]));
      assert.equal(await human.requestExtension!(aRequest), undefined, reply);
    }
  });
});

describe("renderSignoff", () => {
  test("names what each criterion will actually be checked with", () => {
    const lines = renderSignoff(
      aPresentation({
        criteria: [
          aCriterion({ id: "c1", check: { kind: "command", command: "npm test" } }),
          aCriterion({ id: "c2", check: { kind: "judge", rubric: "counts equal, no orphans" } }),
        ],
      }),
    ).join("\n");

    assert.match(lines, /check ▸ command: npm test/);
    assert.match(lines, /check ▸ judge: counts equal, no orphans/);
  });

  // A criterion with no check means the mission can never legitimately report success
  // (§4), so a spec with none at all should read as alarming rather than as tidy.
  test("says so when there is nothing to check", () => {
    const lines = renderSignoff(aPresentation({ criteria: [] })).join("\n");

    assert.match(lines, /nothing here can report success/);
  });

  test("omits the guesses block when there are none, rather than printing an empty one", () => {
    const lines = renderSignoff(aPresentation({ guesses: [] })).join("\n");

    assert.equal(/GUESSES/.test(lines), false);
  });
});
