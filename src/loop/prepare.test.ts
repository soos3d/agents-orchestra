// Everything before the first worker runs, and the gate that matters most: an
// outcome spec the runtime cannot evaluate is rejected here rather than discovered
// twenty rounds later, when every internal check has been reporting success.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type LoreEntry } from "../memory/lore.js";
import { type EventInput } from "../events/schema.js";
import {
  aCriterion,
  aPlannedTask,
  anAgentSpec,
  anIntakeQuestion,
  aProgressLedger,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import {
  type Calls,
  type IntakeQuestion,
  type PlanInput,
  type PlanResult,
  type ResearchResult,
} from "./calls.js";
import { type HumanPort, type SignoffPresentation } from "./human.js";
import { MAX_SIGNOFF_REVISIONS, prepareMission, presentAndSignOff } from "./prepare.js";
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

const aResearchResult = (patch: Partial<ResearchResult> = {}): ResearchResult => ({
  brief: "The repo has a router but no health route.",
  findings: [
    { claim: "Routes live in src/routes", source: "src/routes/index.ts", sourceKind: "codebase", confidence: "high" },
  ],
  confidence: "high",
  criteria: [aCriterion()],
  guesses: [],
  outOfScope: ["rewriting the router"],
  ...patch,
});

/** The scan is cheap and finds nothing worth a question, which is the common case
 *  (§2b) and the one every test below assumes unless it says otherwise. */
const aScanResult = (patch: Partial<ResearchResult> = {}): ResearchResult => ({
  brief: "",
  findings: [],
  confidence: "low",
  ...patch,
});

function callsFor(options: {
  scan?: ResearchResult;
  research?: ResearchResult[];
  plan?: PlanResult[];
  intake?: IntakeQuestion[];
}): Calls & { synthesized: number; planInputs: PlanInput[] } {
  let researchIndex = 0;
  let planIndex = 0;
  const counters = { synthesized: 0 };
  const planInputs: PlanInput[] = [];

  return {
    planInputs,
    get synthesized() {
      return counters.synthesized;
    },
    // Scan and research are one decision point at two depths (§3), so the stub tells
    // them apart the same way the real call does. Without this the scan would eat the
    // first scripted research answer, and every test below that scripts a rejection
    // would be asserting against the wrong call.
    research: async (input) => {
      if (input.depth === "scan") return options.scan ?? aScanResult();
      return options.research?.[researchIndex++] ?? aResearchResult();
    },
    intake: async () => ({ questions: options.intake ?? [] }),
    plan: async (input) => {
      planInputs.push(input);
      const answer = options.plan?.[planIndex++] ?? { tasks: [aPlannedTask()] };
      return answer;
    },
    synthesize: async () => {
      counters.synthesized++;
      return anAgentSpec();
    },
    progress: async () => aProgressLedger(),
    judge: async () => {
      throw new Error("prepare does not judge");
    },
  };
}

const types = (store: { inputs: EventInput[] }) => store.inputs.map((event) => event.type);

describe("prepareMission", () => {
  test("researches, writes the spec, plans, and estimates", async () => {
    const store = testStore();

    const result = await prepareMission({ store, calls: callsFor({}) });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.estimate.taskCount === 1);
    assert.ok(result.ok && result.estimate.wallMs > 0);
    // The order is the design (§2b): look before you ask, ask before you research.
    // A scan that ran after intake would be paying for questions asked blind.
    assert.deepEqual(types(store).slice(0, 6), [
      "mission_created",
      "scan_completed",
      "mission_status", // → intake
      "mission_status", // → researching
      "research_completed",
      "mission_status", // → specifying
    ]);
    assert.ok(types(store).includes("outcome_spec_written"));
  });

  test("puts sourced findings into the ledger as verified facts", async () => {
    const store = testStore();

    await prepareMission({ store, calls: callsFor({}) });

    const facts = store.state().mission.ledger.factsVerified;
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.source.ref, "src/routes/index.ts");
    assert.equal(facts[0]?.source.kind, "research");
  });

  test("reaches executing with a synthesized agent per task", async () => {
    const store = testStore();
    const calls = callsFor({ plan: [{ tasks: [aPlannedTask({ id: "t1" }), aPlannedTask({ id: "t2" })] }] });

    await prepareMission({ store, calls });

    assert.equal(calls.synthesized, 2);
    assert.equal(store.state().mission.status, "executing");
    assert.equal(store.state().tasks.length, 2);
  });

  // Criteria freeze from sign-off, so it has to be granted before any work runs.
  test("records sign-off, which is what freezes the criteria", async () => {
    const store = testStore();

    await prepareMission({ store, calls: callsFor({}) });

    assert.ok(store.state().mission.signedOffAt);
  });

  describe("the outcome spec gate", () => {
    test("rejects an uncheckable criterion and retries research once", async () => {
      const store = testStore();
      const vague = aResearchResult({
        criteria: [{ id: "c1", statement: "the checkout flow is less janky" }],
      });

      const result = await prepareMission({
        store,
        calls: callsFor({ research: [vague, aResearchResult()] }),
      });

      assert.equal(result.ok, true);
      assert.ok(types(store).includes("outcome_spec_rejected"));
    });

    test("gives up after the second rejection rather than planning against nothing", async () => {
      const store = testStore();
      const vague = aResearchResult({ criteria: [{ id: "c1", statement: "make it nicer" }] });

      const result = await prepareMission({
        store,
        calls: callsFor({ research: [vague, vague] }),
      });

      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.rejected?.length === 1);
      assert.ok(!result.ok && /could never legitimately report success/.test(result.reason));
      assert.equal(types(store).includes("outcome_spec_written"), false);
    });
  });

  // Sign-off is the one place blocking pays for itself (§2b): reviewing a plan costs a
  // minute, and the error it catches — optimising correctly for the wrong outcome — is
  // the only failure the loop cannot detect, because every internal check reports
  // success. So the assertions here are about it actually blocking.
  describe("sign-off", () => {
    const approving = (
      onPresent?: (presentation: SignoffPresentation) => void,
    ): HumanPort => ({
      askIntake: async () => [],
      awaitSignoff: async (presentation) => {
        onPresent?.(presentation);
        return { kind: "approve" };
      },
    });

    test("synthesizes nothing until the human approves", async () => {
      const store = testStore();
      const calls = callsFor({});
      const seen: { synthesized: number; status: string }[] = [];

      await prepareMission({
        store,
        calls,
        human: approving(() => {
          seen.push({ synthesized: calls.synthesized, status: store.state().mission.status });
        }),
      });

      assert.deepEqual(seen, [{ synthesized: 0, status: "awaiting_signoff" }]);
      assert.equal(store.state().mission.status, "executing");
      assert.equal(calls.synthesized, 1);
    });

    // The status has to be on disk before the await, or a mission killed while waiting
    // comes back looking like it was still planning.
    test("records awaiting_signoff before it blocks, so a crash is recoverable", async () => {
      const store = testStore();
      const crash: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () => {
          throw new Error("the process died while the human was reading");
        },
      };

      await assert.rejects(prepareMission({ store, calls: callsFor({}), human: crash }));
      assert.equal(store.state().mission.status, "awaiting_signoff");
      assert.equal(store.state().mission.signedOffAt, undefined);
    });

    // The milestone: a mission left overnight is still approvable. Approved through
    // `presentAndSignOff` rather than a second code path, which is the point of
    // splitting it out — the resumed route is the one nobody exercises by accident.
    test("a mission abandoned at the screen is approved by a later run", async () => {
      const store = testStore();
      const crash: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () => {
          throw new Error("killed");
        },
      };
      await assert.rejects(prepareMission({ store, calls: callsFor({}), human: crash }));

      // A new process: nothing in memory, everything refolded from the log.
      const resumed = testStore(store.inputs);
      const outcome = await presentAndSignOff({
        store: resumed,
        calls: callsFor({}),
        human: approving(),
      });

      assert.equal(outcome.ok, true);
      assert.equal(resumed.state().mission.status, "executing");
      assert.ok(resumed.state().mission.signedOffAt);
    });

    test("the screen shows the criteria, the guesses, and the estimate", async () => {
      const store = testStore();
      let shown: SignoffPresentation | undefined;

      await prepareMission({
        store,
        calls: callsFor({}),
        human: approving((presentation) => {
          shown = presentation;
        }),
      });

      assert.equal(shown?.criteria.length, 1);
      assert.equal(shown?.plan.length, 1);
      assert.ok((shown?.estimate.taskCount ?? 0) > 0);
      assert.equal(shown?.brief, "The repo has a router but no health route.");
    });

    test("revise sends the feedback to the planner and presents again", async () => {
      const store = testStore();
      const calls = callsFor({
        plan: [{ tasks: [aPlannedTask({ id: "t1" })] }, { tasks: [aPlannedTask({ id: "t2" })] }],
      });

      let presented = 0;
      const human: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () => {
          presented++;
          return presented === 1
            ? { kind: "revise", feedback: "split the migration out of task one" }
            : { kind: "approve" };
        },
      };

      const result = await prepareMission({ store, calls, human });

      assert.equal(presented, 2);
      assert.match(calls.planInputs.at(-1)?.reason ?? "", /split the migration out/);
      assert.ok(result.ok && result.plan[0]?.id === "t2");
      assert.ok(types(store).includes("signoff_revised"));
      assert.equal(store.state().mission.status, "executing");
    });

    test("gives up rather than presenting forever", async () => {
      const store = testStore();
      const stubborn: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () => ({ kind: "revise", feedback: "no" }),
      };

      const result = await prepareMission({ store, calls: callsFor({}), human: stubborn });

      assert.equal(result.ok, false);
      assert.equal(
        types(store).filter((type) => type === "signoff_revised").length,
        MAX_SIGNOFF_REVISIONS,
      );
      assert.equal(store.state().mission.signedOffAt, undefined);
    });

    // `--unattended` is a supported mode forever (§13), not a missing implementation.
    test("with nobody there it approves and records that it did", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}), unattended: true });

      assert.equal(store.state().mission.status, "executing");
      assert.equal(store.state().mission.unattended, true);
    });

    test("--plan-only stops at the request and never presents", async () => {
      const store = testStore();
      let presented = false;

      const result = await prepareMission({
        store,
        calls: callsFor({}),
        planOnly: true,
        human: approving(() => {
          presented = true;
        }),
      });

      assert.equal(result.ok, true);
      assert.equal(presented, false);
      assert.ok(types(store).includes("signoff_requested"));
      assert.equal(store.state().mission.signedOffAt, undefined);
      assert.equal(store.state().tasks.length, 0);
    });
  });

  // Search before you research (§5, §6). The recall is a closure rather than a lore
  // directory, so nothing here touches disk and the two rules that matter — a stale
  // fact is a guess, and memory ids cannot collide with the scan's — are assertable
  // without a filesystem.
  describe("memory", () => {
    const aLoreEntry = (patch: Partial<LoreEntry> = {}): LoreEntry => ({
      id: "lore-1",
      claim: "the API client lives in src/net",
      type: "observation",
      confidence: "medium",
      source: { missionId: "m0", evidence: "src/net/client.ts", kind: "research" },
      observedAt: "2026-07-01T00:00:00.000Z",
      ...patch,
    });

    const recall = () => ({
      fresh: [aLoreEntry()],
      stale: [aLoreEntry({ id: "lore-2", claim: "Stripe retries webhooks for 3 days" })],
    });

    test("a fresh entry is recalled as a verified fact and a stale one as a guess", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}), recall });

      const ledger = store.state().mission.ledger;
      const memory = ledger.factsVerified.filter((fact) => fact.source.kind === "memory");
      assert.deepEqual(memory.map((fact) => fact.text), ["the API client lives in src/net"]);
      assert.deepEqual(
        ledger.guesses.map((guess) => [guess.text, guess.confidence]),
        [["Stripe retries webhooks for 3 days", "low"]],
      );
      assert.ok(types(store).includes("memory_recalled"));
    });

    // The spec is written after the recall and rewrites `guesses` wholesale, so a
    // stale memory is exactly the thing that quietly disappears here. §6 says it must
    // stay visible on the sign-off screen as something to re-verify.
    test("a stale memory survives the outcome spec rather than being overwritten", async () => {
      const store = testStore();
      const guess = { id: "g1", text: "June means the calendar month", addedRound: 0, confidence: "medium" as const, basis: "the brief" };

      await prepareMission({
        store,
        calls: callsFor({ research: [aResearchResult({ guesses: [guess] })] }),
        recall,
      });

      assert.deepEqual(
        store.state().mission.ledger.guesses.map((entry) => entry.id).sort(),
        ["g1", "mg1"],
      );
    });

    // `motivatedBy` names a ledger entry by id (§4.2), so a second entry answering to
    // the same id points a task's provenance at the wrong fact.
    test("the scan's facts cannot collide with the ids memory allocated", async () => {
      const store = testStore();

      await prepareMission({
        store,
        calls: callsFor({
          scan: aScanResult({
            findings: [
              { claim: "routes live in src/routes", source: "src/routes", sourceKind: "codebase", confidence: "high" },
            ],
          }),
        }),
        recall,
      });

      const ids = store.state().mission.ledger.factsVerified.map((fact) => fact.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, 3); // one recalled, one scanned, one researched
    });

    test("without a recall dependency nothing consults memory", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}) });

      assert.equal(types(store).includes("memory_recalled"), false);
      assert.deepEqual(store.state().mission.ledger.guesses, []);
    });
  });

  describe("intake", () => {
    test("an answer becomes a fact the human gave, which replans cannot drop", async () => {
      const store = testStore();
      const human: HumanPort = {
        askIntake: async (asked) =>
          asked.map((question) => ({ questionId: question.id, answer: "calendar month" })),
        awaitSignoff: async () => ({ kind: "approve" }),
      };

      await prepareMission({
        store,
        calls: callsFor({ intake: [anIntakeQuestion({ id: "q1", question: "Calendar or fiscal?" })] }),
        human,
      });

      const given = store.state().mission.ledger.factsGiven;
      assert.equal(given.length, 1);
      assert.match(given[0]!.text, /Calendar or fiscal\? — calendar month/);
    });

    test("the planner is told what the human answered", async () => {
      const store = testStore();
      const calls = callsFor({ intake: [anIntakeQuestion({ id: "q1", question: "Which suite?" })] });

      await prepareMission({
        store,
        calls,
        human: {
          askIntake: async () => [{ questionId: "q1", answer: "npm test" }],
          awaitSignoff: async () => ({ kind: "approve" }),
        },
      });

      assert.match(JSON.stringify(calls.planInputs[0]?.ledger.factsGiven), /npm test/);
    });
  });

  describe("plan validation", () => {
    test("retries once, quoting the offending edge", async () => {
      const store = testStore();
      const calls = callsFor({
        plan: [
          { tasks: [aPlannedTask({ id: "t1", dependsOn: ["t9"] })] },
          { tasks: [aPlannedTask({ id: "t1" })] },
        ],
      });

      const result = await prepareMission({ store, calls });

      assert.equal(result.ok, true);
      assert.equal(calls.synthesized, 1);
    });

    test("stops before synthesizing anything when the plan cycles", async () => {
      const store = testStore();
      const cyclic: PlanResult = {
        tasks: [
          aPlannedTask({ id: "t1", dependsOn: ["t2"] }),
          aPlannedTask({ id: "t2", dependsOn: ["t1"] }),
        ],
      };
      const calls = callsFor({ plan: [cyclic, cyclic] });

      const result = await prepareMission({ store, calls });

      assert.equal(result.ok, false);
      assert.ok(!result.ok && /cycle/.test(result.reason));
      assert.equal(calls.synthesized, 0);
    });
  });

  describe("--plan-only", () => {
    test("produces a spec, a plan, and an estimate without synthesizing an agent", async () => {
      const store = testStore();
      const calls = callsFor({});

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      assert.ok(result.ok && result.plan.length === 1);
      assert.equal(calls.synthesized, 0);
      assert.equal(store.state().tasks.length, 0);
    });

    test("stops at the sign-off request, so nothing is approved and nothing runs", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}), planOnly: true });

      assert.ok(types(store).includes("signoff_requested"));
      assert.equal(types(store).includes("signoff_granted"), false);
      assert.equal(store.state().mission.status, "specifying");
    });
  });
});
