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
}): Calls & { synthesized: number; planInputs: PlanInput[]; depths: string[] } {
  let researchIndex = 0;
  let planIndex = 0;
  const counters = { synthesized: 0 };
  const planInputs: PlanInput[] = [];
  const depths: string[] = [];

  return {
    planInputs,
    depths,
    get synthesized() {
      return counters.synthesized;
    },
    // Scan and research are one decision point at two depths (§3), so the stub tells
    // them apart the same way the real call does. Without this the scan would eat the
    // first scripted research answer, and every test below that scripts a rejection
    // would be asserting against the wrong call.
    research: async (input) => {
      depths.push(input.depth);
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

  // The failure mode under test: a retry that is a blind re-roll.
  //
  // `plan` has always been told why its last answer was refused (`PlanInput.reason`)
  // and `synthesize` has `rejected` for the same purpose — `research` alone re-ran on
  // a byte-identical input, so the one call whose answer decides whether the mission
  // can ever report success was the one asked to guess again. Context the system
  // already paid for, discarded and re-derived.
  describe("the outcome spec retry", () => {
    test("tells research what was wrong with the criteria it just returned", async () => {
      const store = testStore();
      const inputs: unknown[] = [];
      const calls = callsFor({
        research: [
          aResearchResult({ criteria: [{ id: "c1", statement: "it is good" }] }),
          aResearchResult(),
        ],
      });
      const recording: Calls = {
        ...calls,
        research: async (input) => {
          inputs.push(input);
          return calls.research(input);
        },
      };

      const result = await prepareMission({ store, calls: recording, planOnly: true });

      assert.equal(result.ok, true);
      const retry = inputs.at(-1) as { rejected?: string };
      assert.ok(retry.rejected, "the retry was asked the same question with no idea what failed");
      assert.match(retry.rejected, /it is good/);
    });

    test("the first call is not told about a rejection that has not happened", async () => {
      const store = testStore();
      const inputs: unknown[] = [];
      const calls = callsFor({});
      const recording: Calls = {
        ...calls,
        research: async (input) => {
          inputs.push(input);
          return calls.research(input);
        },
      };

      await prepareMission({ store, calls: recording, planOnly: true });

      assert.equal((inputs.at(-1) as { rejected?: string }).rejected, undefined);
    });
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

  // The failure mode under test: a small job paying for a deep research pass it did
  // not need, and a plan that decomposes a one-line script into four tasks.
  //
  // `quick` is the human's own judgment at compose time, and it is a *hint* — every
  // guarantee below it is unchanged. The gate that makes that safe is the one already
  // here: `writeOutcomeSpec` refuses a criterion nothing can evaluate, whatever depth
  // produced it, and a scan-derived spec it refuses escalates to the deep call the
  // mission skipped. So a box checked on a job that was not small costs one research
  // call, not a mission.
  //
  // The other half is what a skipped stage does to the page. `briefing.ts` marks the
  // research row done on `view.brief !== ""`, so a quick mission still emits
  // `research_completed` — carrying the scan's brief, which was previously discarded.
  // Without that the row pulses forever above stages that have already finished.
  describe("a quick mission", () => {
    const quickStore = () => testStore([missionCreated({ quick: true } as Partial<EventInput>)]);

    test("skips the deep research call and runs the scan only", async () => {
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "One file, one function.", criteria: [aCriterion()] }) });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      assert.deepEqual(calls.depths, ["scan"], "a quick mission paid for a deep research call");
    });

    test("still writes a brief, so the briefing's research row can finish", async () => {
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "One file, one function.", criteria: [aCriterion()] }) });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(store.state().brief, "One file, one function.");
    });

    test("takes its outcome spec from the scan rather than inventing one", async () => {
      const store = quickStore();
      // Same id as the default, so the planned task still satisfies it — the statement
      // is what distinguishes the scan's criterion from the deep call's.
      const scanCriterion = aCriterion({ statement: "rotate.sh exits 0 on an empty directory" });
      const calls = callsFor({ scan: aScanResult({ brief: "small", criteria: [scanCriterion] }) });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.ok(result.ok);
      assert.equal(
        result.ok && result.criteria[0]?.statement,
        "rotate.sh exits 0 on an empty directory",
      );
    });

    test("escalates to the deep call when the scan's spec is refused", async () => {
      // The box was checked on a job that was not small. The gate catches it, and the
      // retry is the research call the mission skipped rather than a second scan —
      // which is what makes a wrong checkbox cost one call instead of a mission.
      const store = quickStore();
      const calls = callsFor({
        scan: aScanResult({ brief: "small", criteria: [{ id: "c1", statement: "it is good" }] }),
        research: [aResearchResult()],
      });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      assert.deepEqual(calls.depths, ["scan", "deep"]);
      assert.ok(types(store).includes("outcome_spec_rejected"));
    });

    test("tells the planner the job is small", async () => {
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "small", criteria: [aCriterion()] }) });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.planInputs[0]?.scope, "quick");
    });

    // The hole the human-checkbox design opened, and the reason it is not obvious: the
    // scan runs *before* intake and the deep call runs after (§2b's ordering). Reusing
    // the scan's criteria therefore means the outcome spec was written by a call that
    // never saw the human's answers — so a quick mission that asked "calendar or
    // fiscal?" and was told "fiscal" would be judged against criteria written before
    // anyone knew. Whichever way `quick` is decided, that has to be closed in code.
    test("runs the deep call anyway when intake produced answers", async () => {
      const store = quickStore();
      const calls = callsFor({
        scan: aScanResult({ brief: "small", criteria: [aCriterion()] }),
        intake: [anIntakeQuestion({ id: "q1", question: "Calendar or fiscal?" })],
      });

      await prepareMission({
        store,
        calls,
        planOnly: true,
        human: {
          askIntake: async () => [{ questionId: "q1", answer: "fiscal" }],
          awaitSignoff: async () => ({ kind: "approve" }),
        },
      });

      assert.deepEqual(
        calls.depths,
        ["scan", "deep"],
        "the spec was written before the human's answer existed",
      );
    });

    test("a question nobody answered does not force the deep call", async () => {
      // `--unattended` asks and gets nothing back. There are no answers the scan could
      // have missed, so there is nothing to re-research.
      const store = quickStore();
      const calls = callsFor({
        scan: aScanResult({ brief: "small", criteria: [aCriterion()] }),
        intake: [anIntakeQuestion({ id: "q1", question: "Calendar or fiscal?" })],
      });

      await prepareMission({ store, calls, planOnly: true, unattended: true });

      assert.deepEqual(calls.depths, ["scan"]);
    });

    test("buys back the research it skipped when the human sends the plan back", async () => {
      // The human is contradicting their own checkbox: they said small, and the plan
      // they were shown says otherwise. Replanning over scan-depth findings would
      // answer that with the same thin ground twice.
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "small", criteria: [aCriterion()] }) });
      let asked = 0;
      const human: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () =>
          asked++ === 0 ? { kind: "revise", feedback: "this needs the migration too" } : { kind: "approve" },
      };

      await prepareMission({ store, calls, human });

      assert.deepEqual(calls.depths, ["scan", "deep"]);
    });

    test("a second send-back does not buy a third research call", async () => {
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "small", criteria: [aCriterion()] }) });
      let asked = 0;
      const human: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () =>
          asked++ < 2 ? { kind: "revise", feedback: "still not right" } : { kind: "approve" },
      };

      await prepareMission({ store, calls, human });

      assert.deepEqual(calls.depths, ["scan", "deep"]);
    });

    test("an ordinary mission sent back replans without re-researching", async () => {
      const store = testStore();
      const calls = callsFor({});
      let asked = 0;
      const human: HumanPort = {
        askIntake: async () => [],
        awaitSignoff: async () =>
          asked++ === 0 ? { kind: "revise", feedback: "narrower please" } : { kind: "approve" },
      };

      await prepareMission({ store, calls, human });

      assert.deepEqual(calls.depths, ["scan", "deep"], "an ordinary revision paid for research");
    });

    test("an ordinary mission is untouched — deep research, no scope", async () => {
      const store = testStore();
      const calls = callsFor({});

      await prepareMission({ store, calls, planOnly: true });

      assert.deepEqual(calls.depths, ["scan", "deep"]);
      assert.equal(calls.planInputs[0]?.scope, undefined);
    });
  });
});
