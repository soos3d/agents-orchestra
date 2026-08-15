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
  estimate: { taskCount: 1, wallMs: 35 * 60_000, expectedGates: 2 },
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
    assert.match(output, /ESTIMATE  1 tasks · ~35 min · 2 gates/);
    // The estimate names shape and wall-clock and no token figure at all
    // (`loop/estimate.ts`). This assertion used to demand one.
    assert.doesNotMatch(output, /tokens/);
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

// A permission request is the one prompt that arrives *mid-run*, with a worker
// waiting on the other end. The rule it shares with sign-off is the important one:
// end of input is not approval, and it is not a silent denial either — it raises, so
// the browser (which races this port through `anyOf`) still gets its turn.
describe("the terminal permission prompt", () => {
  const anAsk = { requestId: "perm-t1-1", taskId: "t1", tool: "Write", detail: "src/clamp.ts" };

  test("allows on the short forms a human actually types", async () => {
    for (const reply of ["y", "yes", "a", "allow", "  Y  "]) {
      const human = createTerminalHuman(capture(), scriptedPrompter([reply]));
      assert.equal(await human.askPermission!(anAsk), true, reply);
    }
  });

  test("denies on an explicit no, which is a decision and not a failure", async () => {
    for (const reply of ["n", "no", "d", "deny"]) {
      const human = createTerminalHuman(capture(), scriptedPrompter([reply]));
      assert.equal(await human.askPermission!(anAsk), false, reply);
    }
  });

  // Neither answer by default: an allow granted by leaning on Enter is the grant §7
  // reserves for a human, taken by a keystroke.
  test("an empty reply re-asks rather than defaulting either way", async () => {
    const prompter = recording(["", "n"]);

    assert.equal(await createTerminalHuman(capture(), prompter).askPermission!(anAsk), false);
    assert.equal(prompter.prompts.length, 2);
  });

  test("shows the task, the tool, and what it wants to do with it", async () => {
    const io = capture();

    await createTerminalHuman(io, scriptedPrompter(["y"])).askPermission!(anAsk);

    const output = io.lines.join("\n");
    assert.match(output, /t1/);
    assert.match(output, /Write/);
    assert.match(output, /src\/clamp\.ts/);
  });

  // The race, exactly as intake plays it: a machine with no tty must lose rather than
  // answering for the human, or the dashboard is never asked.
  test("raises when the input ends, so another surface can still answer", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([]));

    await assert.rejects(() => human.askPermission!(anAsk), /dashboard|terminal/i);
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

// The mid-mission return (§3, §13): the same screen, showing what a replan wants to
// change and why, rather than a fresh spec. Defect 29 was this screen not existing on
// any surface, so the mission parked at a door with nothing behind it.
describe("the criteria-change screen", () => {
  const amended = aCriterion({ id: "c1", statement: "GET /health returns 200 and a build sha" });

  const proposing = () =>
    aPresentation({
      proposedChange: {
        reasoning: "no plan can satisfy c1 as written; the endpoint has no version to report",
        diff: [
          {
            op: "amend",
            criterionId: "c1",
            from: aCriterion({ id: "c1" }),
            to: amended,
            reason: "the sha is what the deploy check actually reads",
          },
        ],
      },
    });

  test("renders the diff from the event: what it says now, what it would say, and why", () => {
    const lines = renderSignoff(proposing()).join("\n");

    assert.match(lines, /PROPOSED CHANGE/);
    assert.match(lines, /amend c1/);
    assert.match(lines, new RegExp(aCriterion().statement));
    assert.match(lines, /GET \/health returns 200 and a build sha/);
    assert.match(lines, /the sha is what the deploy check actually reads/);
    assert.match(lines, /no plan can satisfy c1 as written/);
  });

  test("renders an add and a remove without inventing a before or an after", () => {
    const lines = renderSignoff(
      aPresentation({
        proposedChange: {
          reasoning: "the report was never in scope",
          diff: [
            { op: "remove", criterionId: "c2", reason: "there is no report to write" },
            { op: "add", criterion: aCriterion({ id: "c3", statement: "the summary is under 500 words" }) },
          ],
        },
      }),
    ).join("\n");

    assert.match(lines, /remove c2/);
    assert.match(lines, /there is no report to write/);
    assert.match(lines, /add c3/);
    assert.match(lines, /the summary is under 500 words/);
  });

  test("the initial sign-off screen carries no diff block", () => {
    assert.equal(/PROPOSED CHANGE/.test(renderSignoff(aPresentation()).join("\n")), false);
  });
});

describe("the terminal on a criteria change", () => {
  const proposing = (): SignoffPresentation =>
    aPresentation({
      proposedChange: {
        reasoning: "c1 cannot be met by any plan",
        diff: [{ op: "remove", criterionId: "c1", reason: "there is no endpoint to check" }],
      },
    });

  test("approve applies it; anything else is a reasoned rejection", async () => {
    const approved = await createTerminalHuman(capture(), scriptedPrompter(["approve"])).awaitSignoff(
      proposing(),
    );
    assert.deepEqual(approved, { kind: "approve" });

    const rejected = await createTerminalHuman(
      capture(),
      scriptedPrompter(["c1 stands; find another way"]),
    ).awaitSignoff(proposing());
    assert.deepEqual(rejected, { kind: "revise", feedback: "c1 stands; find another way" });
  });

  // The same rule the initial screen has, and it matters more here: these ports race,
  // and a terminal with no tty that answered for the human would decide a contract
  // change the dashboard was about to show somebody.
  test("end of input rejects rather than resolving, so the dashboard can still answer", async () => {
    const human = createTerminalHuman(capture(), scriptedPrompter([]));

    await assert.rejects(() => human.awaitSignoff(proposing()), /--unattended|terminal/);
  });

  test("the prompt asks about the change, not about the plan", async () => {
    const prompter = recording(["approve"]);

    await createTerminalHuman(capture(), prompter).awaitSignoff(proposing());

    assert.match(prompter.prompts.join("\n"), /reject/i);
  });
});
