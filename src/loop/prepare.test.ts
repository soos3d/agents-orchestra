// Everything before the first worker runs, and the gate that matters most: an
// outcome spec the runtime cannot evaluate is rejected here rather than discovered
// twenty rounds later, when every internal check has been reporting success.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fold } from "../events/fold.js";
import { type LoreEntry } from "../memory/lore.js";
import { type EventInput } from "../events/schema.js";
import {
  anEnvelope,
  aCriterion,
  aPlannedTask,
  anAgentSpec,
  anIntakeQuestion,
  aProgressLedger,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import {
  type ArchitectInput,
  type ArchitectResult,
  type Calls,
  type CritiqueInput,
  type CritiqueResult,
  type IntakeQuestion,
  type PlanInput,
  type PlanResult,
  type ResearchResult,
} from "./calls.js";
import { type HumanPort, type SignoffPresentation } from "./human.js";
import {
  MAX_SIGNOFF_REVISIONS,
  appendFacts,
  prepareMission,
  presentAndSignOff,
} from "./prepare.js";
import { type Fact, type Finding } from "../domain/ledger.js";
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
  architect?: ArchitectResult[];
  critique?: CritiqueResult[];
  plan?: PlanResult[];
  intake?: IntakeQuestion[];
}): Calls & {
  synthesized: number;
  planInputs: PlanInput[];
  critiqueInputs: CritiqueInput[];
  depths: string[];
  architectInputs: ArchitectInput[];
} {
  let researchIndex = 0;
  let architectIndex = 0;
  let critiqueIndex = 0;
  let planIndex = 0;
  const architectInputs: ArchitectInput[] = [];
  const counters = { synthesized: 0 };
  const planInputs: PlanInput[] = [];
  const critiqueInputs: CritiqueInput[] = [];
  const depths: string[] = [];

  return {
    planInputs,
    critiqueInputs,
    depths,
    architectInputs,
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
    // The architect writes the outcome spec on an ordinary mission (PLAN-NEXT 5.1).
    // Unscripted, it hands back whatever criteria the research answer carried, which is
    // what keeps every test written before it existed asserting about its own script.
    architect: async (input) => {
      architectInputs.push(input);
      return (
        options.architect?.[architectIndex++] ?? {
          criteria: (options.research?.[researchIndex - 1] ?? aResearchResult()).criteria,
          designNote: "# Design\n\nOne module, one test.",
        }
      );
    },
    intake: async () => ({ questions: options.intake ?? [] }),
    critique: async (input) => {
      critiqueInputs.push(input);
      return options.critique?.[critiqueIndex++] ?? { objections: [] };
    },
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

// The failure mode under test: a later "fix" that concatenates claim+source, or
// swaps `\0` for a printable delimiter, makes two different findings look like
// one — and `motivatedBy` then names the wrong fact. The separator is why the
// source used to carry literal NUL bytes; the lock is the collision, not the
// spelling of the escape.
describe("appendFacts", () => {
  const at = "2026-08-18T00:00:00.000Z";
  const fact = (id: string, text: string, ref: string): Fact => ({
    id,
    text,
    addedRound: 0,
    source: { kind: "research", ref },
    observedAt: at,
  });
  const finding = (claim: string, source: string): Finding => ({
    claim,
    source,
    sourceKind: "codebase",
    confidence: "high",
  });

  test("drops a finding already on record", () => {
    const existing = [fact("f1", "routes live in src/routes", "src/routes")];
    const out = appendFacts(existing, [finding("routes live in src/routes", "src/routes")], at);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, "f1");
  });

  test("keeps a different claim or a different source, with the next free id", () => {
    const existing = [fact("f1", "routes live in src/routes", "src/routes")];
    const out = appendFacts(
      existing,
      [
        finding("routes live in src/routes", "src/app.ts"),
        finding("tests live in src/routes.test.ts", "src/routes"),
      ],
      at,
    );
    assert.deepEqual(
      out.map((entry) => entry.id),
      ["f1", "f2", "f3"],
    );
    assert.equal(out[1]!.source.ref, "src/app.ts");
    assert.equal(out[2]!.text, "tests live in src/routes.test.ts");
  });

  test("does not treat claim+source concatenation as identity", () => {
    const existing = [fact("f1", "ab", "c")];
    const out = appendFacts(existing, [finding("a", "bc")], at);
    assert.equal(out.length, 2, "ab+c and a+bc collide if the separator is dropped");
    assert.equal(out[1]!.id, "f2");
    assert.equal(out[1]!.text, "a");
    assert.equal(out[1]!.source.ref, "bc");
  });

  test("the source file has no literal NUL, so ripgrep can search it", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./prepare.ts", import.meta.url)), "utf8");
    assert.equal(src.includes("\u0000"), false);
    assert.match(src, /\\0\$\{fact\.source\.ref\}/);
  });
});

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
    // The spec moved from `research` to `architect` in PLAN-NEXT 5.1, and the retry moved
    // with it: whoever wrote the criteria the gate refused is who is told why.
    test("tells the architect what was wrong with the criteria it just returned", async () => {
      const store = testStore();
      const calls = callsFor({
        architect: [
          { criteria: [{ id: "c1", statement: "it is good" }], designNote: "# Design" },
          { criteria: [aCriterion()], designNote: "# Design" },
        ],
      });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      const retry = calls.architectInputs.at(-1);
      assert.ok(retry?.rejected, "the retry was asked the same question with no idea what failed");
      assert.match(retry.rejected, /it is good/);
    });

    test("the first call is not told about a rejection that has not happened", async () => {
      const store = testStore();
      const calls = callsFor({});

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.architectInputs.at(-1)?.rejected, undefined);
    });
  });

  describe("the outcome spec gate", () => {
    test("rejects an uncheckable criterion and retries the architect once", async () => {
      const store = testStore();
      const vague = {
        criteria: [{ id: "c1", statement: "the checkout flow is less janky" }],
        designNote: "# Design",
      };

      const result = await prepareMission({
        store,
        calls: callsFor({ architect: [vague, { criteria: [aCriterion()], designNote: "# D" }] }),
      });

      assert.equal(result.ok, true);
      assert.ok(types(store).includes("outcome_spec_rejected"));
    });

    test("gives up after the second rejection rather than planning against nothing", async () => {
      const store = testStore();
      const vague = {
        criteria: [{ id: "c1", statement: "make it nicer" }],
        designNote: "# Design",
      };

      const result = await prepareMission({
        store,
        calls: callsFor({ architect: [vague, vague] }),
      });

      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.rejected?.length === 1);
      assert.ok(!result.ok && /could never legitimately report success/.test(result.reason));
      assert.equal(types(store).includes("outcome_spec_written"), false);
    });

    // The failure mode under test, seen on a real VPS: two missions printed "The
    // outcome spec was rejected twice", exited 1, and left a log ending at
    // `outcome_spec_rejected` — so `mission.json`, which is folded from that log,
    // still read `specifying` and the dashboard showed a dead mission as working
    // forever. The process exiting is not a fact the log carries.
    test("leaves the mission blocked rather than reading as still specifying", async () => {
      const store = testStore();
      const vague = {
        criteria: [{ id: "c1", statement: "make it nicer" }],
        designNote: "# Design",
      };

      const result = await prepareMission({
        store,
        calls: callsFor({ architect: [vague, vague] }),
      });

      assert.equal(result.ok, false);
      assert.equal(store.state().mission.status, "blocked");
      const last = store.inputs.at(-1);
      assert.equal(last?.type, "mission_status");
      assert.ok(
        last?.type === "mission_status" && /rejected twice/.test(last.reason),
        "the terminal event has to say what happened",
      );
      assert.ok(
        last?.type === "mission_status" && /Re-run/.test(last.reason),
        "and what the human can do about it",
      );
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

    // The whole of what PLAN-NEXT 5 adds to a quick mission is nothing. Its spec is the
    // scan's own criteria, it gets no design note, and its one-task plan has no
    // dependency to miss and no lease to collide with — so neither new call is paid for
    // and the token count a quick mission had before this stage is the one it has now.
    test("pays for neither the architect nor the critic", async () => {
      const store = quickStore();
      const calls = callsFor({ scan: aScanResult({ brief: "small", criteria: [aCriterion()] }) });

      await prepareMission({ store, calls, planOnly: true, writeDesign: () => "/tmp/design.md" });

      assert.equal(calls.architectInputs.length, 0);
      assert.equal(types(store).includes("design_written"), false);
      assert.equal(types(store).includes("plan_critiqued"), false);
      assert.equal(calls.planInputs.length, 1, "a quick mission paid for a replan");
    });
  });

  // PLAN-NEXT 7.1. The failure this guards against is a mission that stops dead at 2am
  // because the design mentioned an API key: research and planning are already paid for,
  // and nobody is awake to grant anything.
  describe("credentials the design asks for", () => {
    const architectWanting = (envVars: string[]) => ({
      criteria: [aCriterion()],
      designNote: "# Design\n\nA payment client behind an interface.",
      envVars,
    });

    test("an ungranted variable raises a question and the mission plans anyway", async () => {
      const store = testStore();
      const calls = callsFor({ architect: [architectWanting(["STRIPE_KEY"])] });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true, "the mission stopped for a key it was told to mock");
      const raised = store.inputs.find((event) => event.type === "secret_required");
      assert.deepEqual(
        raised && "names" in raised ? raised.names : [],
        ["STRIPE_KEY"],
      );
      const asked = store.inputs.find((event) => event.type === "question_asked");
      assert.match(asked && "question" in asked ? asked.question : "", /--env STRIPE_KEY/);
      // Nothing exists to park: the plan is written after this call answers.
      assert.deepEqual(asked && "blocks" in asked ? asked.blocks : ["x"], []);
      // And the event says so itself (PLAN-NEXT 7.2). Without the flag at the emit site,
      // a mission that later parks on a 529 never resumes past a question nobody answers
      // — `blocks: []` reads the same as a reset-cap escalation with every task done.
      assert.equal(asked && "advisory" in asked ? asked.advisory : undefined, true);
    });

    test("a variable the envelope already grants raises nothing", async () => {
      const store = testStore([
        missionCreated({ envelope: anEnvelope({ env: ["STRIPE_KEY"] }) } as Partial<EventInput>),
      ]);
      const calls = callsFor({ architect: [architectWanting(["STRIPE_KEY"])] });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(types(store).includes("secret_required"), false);
      assert.equal(types(store).includes("question_asked"), false);
    });

    // The architect gets one retry and answers `envVars` again. A second inbox item for
    // the same variable is a human answering the same question twice.
    test("the architect's retry does not re-ask for a name already raised", async () => {
      const store = testStore();
      const calls = callsFor({
        architect: [
          { ...architectWanting(["STRIPE_KEY"]), criteria: [{ statement: "no check" }] },
          architectWanting(["STRIPE_KEY", "SLACK_TOKEN"]),
        ],
      });

      await prepareMission({ store, calls, planOnly: true });

      const raised = store.inputs
        .filter((event) => event.type === "secret_required")
        .flatMap((event) => ("names" in event ? event.names : []));
      assert.deepEqual(raised, ["STRIPE_KEY", "SLACK_TOKEN"]);
      assert.deepEqual(store.state().secretsRequired, ["STRIPE_KEY", "SLACK_TOKEN"]);
    });

    test("an architect that names no variable leaves the log byte-identical", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}), planOnly: true });

      assert.equal(types(store).includes("secret_required"), false);
    });
  });

  // PLAN-NEXT 5.1. The note is what a code worker is handed a path to, so the event has
  // to name a file that exists — an event written ahead of the write would put a dead
  // path into every worker's prompt, which is defect 40 one layer up.
  describe("the design note", () => {
    test("is written and its path folded, with the planner getting a summary", async () => {
      const store = testStore();
      const written: string[] = [];
      const calls = callsFor({
        architect: [{ criteria: [aCriterion()], designNote: "# Design\n\nOne module, one test." }],
      });

      await prepareMission({
        store,
        calls,
        planOnly: true,
        writeDesign: (note) => {
          written.push(note);
          return "/state/missions/m1/artifacts/design.md";
        },
      });

      assert.deepEqual(written, ["# Design\n\nOne module, one test."]);
      assert.equal(store.state().design?.path, "/state/missions/m1/artifacts/design.md");
      assert.match(calls.planInputs[0]?.design ?? "", /One module, one test/);
    });

    // The prepare phase runs before `buildLoopDeps` derives the scrubber's list, which
    // left the note, its summary and the research brief as the three surfaces written in
    // front of the scrubber rather than behind it (PLAN-NEXT 7.3, from the stage's
    // security review). Research and the architect are calls with tools against the
    // repository, so a granted value sitting in a file there can be quoted into a note
    // whose absolute path every code worker's prompt then names.
    test("a granted value the architect quoted never reaches the file or the event", async () => {
      const store = testStore();
      const written: string[] = [];
      const key = "sk_live_9d8f7a6b5c4d";
      const calls = callsFor({
        architect: [
          { criteria: [aCriterion()], designNote: `# Design\n\nUse ${key} from the .env.` },
        ],
      });

      await prepareMission({
        store,
        calls,
        planOnly: true,
        secrets: [{ name: "STRIPE_KEY", value: key }],
        writeDesign: (note) => {
          written.push(note);
          return "/state/missions/m1/artifacts/design.md";
        },
      });

      assert.equal(written.join("").includes(key), false, "the key was written to disk");
      assert.match(written.join(""), /\[redacted:STRIPE_KEY\]/);
      assert.equal(JSON.stringify(store.inputs).includes(key), false, "the key is on the log");
    });

    // Best-effort, like `keepEvidence`: what is lost when a disk is full is the note, not
    // the criteria — those went through `writeOutcomeSpec` and are on the log either way.
    test("a write that fails costs the note and not the mission", async () => {
      const store = testStore();
      const warnings: string[] = [];

      const result = await prepareMission({
        store,
        calls: callsFor({}),
        planOnly: true,
        writeDesign: () => undefined,
        onWarn: (message) => warnings.push(message),
      });

      assert.equal(result.ok, true);
      assert.equal(types(store).includes("design_written"), false);
      assert.match(warnings.join("\n"), /design note could not be written/);
    });

    // A composition root that builds `prepareMission` without this is a feature finished
    // and switched off at once (defects 12b, 23, 24), so the absence has to be survivable
    // rather than silent.
    test("no writer at all plans exactly as before", async () => {
      const store = testStore();

      const result = await prepareMission({ store, calls: callsFor({}), planOnly: true });

      assert.equal(result.ok, true);
      assert.equal(store.state().design, undefined);
    });
  });

  // PLAN-NEXT 5.3. The critic runs between the plan and its validation — the last point
  // where a colliding lease is still cheap. After sign-off it is a worktree.
  describe("the plan critic", () => {
    const objection = {
      objections: [
        { kind: "colliding-lease", detail: "t1 and t2 both write src/api.ts", taskId: "t2" },
      ],
    };

    test("an objection buys exactly one replan, and lands on the log", async () => {
      const store = testStore();
      const calls = callsFor({ critique: [objection] });

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      assert.equal(calls.planInputs.length, 2, "the objection did not buy a replan");
      assert.match(calls.planInputs[1]?.reason ?? "", /both write src\/api\.ts/);
      assert.ok(types(store).includes("plan_critiqued"));
    });

    // A critic that can keep objecting is a budget leak: the second objection to a plan
    // is not worth what the third plan costs. The cap is one replan per critique, and it
    // is not re-run against the plan it asked for.
    test("the replan is not itself critiqued", async () => {
      const store = testStore();
      const calls = callsFor({ critique: [objection, objection] });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.planInputs.length, 2);
      assert.equal(
        store.inputs.filter((event) => event.type === "plan_critiqued").length,
        1,
      );
    });

    // PLAN-NEXT 8.2. The profile is a preset over knobs that already exist, and this is
    // the one it turns up here: the plan the critic bought is itself critiqued once.
    // Asserted as a *cap* rather than as "more", because a critic with no ceiling is a
    // budget leak whichever profile asked for it.
    const moonshotStore = () => testStore([missionCreated({ moonshot: true } as Partial<EventInput>)]);

    test("a moonshot mission critiques the plan the critic bought, and stops there", async () => {
      const store = moonshotStore();
      const calls = callsFor({ critique: [objection, objection, objection] });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.planInputs.length, 3, "two objections did not buy two replans");
      assert.equal(calls.critiqueInputs.length, 2, "the critic ran more than twice");
      assert.equal(
        store.inputs.filter((event) => event.type === "plan_critiqued").length,
        2,
      );
    });

    test("a moonshot mission whose second critique is quiet pays for no third plan", async () => {
      const store = moonshotStore();
      const calls = callsFor({ critique: [objection] });

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.planInputs.length, 2);
      assert.equal(calls.critiqueInputs.length, 2);
    });

    // The design review round (8.2). The critic is the call that can compare a breakdown
    // against what it was supposed to implement, and the objection it raises is one the
    // planner can act on in the replan it already buys. A standard mission's critique
    // carries the bytes it carried before the profile existed.
    test("the design reaches the critic on a moonshot mission and nowhere else", async () => {
      const withDesign = async (store: ReturnType<typeof testStore>) => {
        const calls = callsFor({});
        await prepareMission({
          store,
          calls,
          planOnly: true,
          writeDesign: () => "/state/missions/m1/artifacts/design.md",
        });
        return calls.critiqueInputs;
      };

      assert.match((await withDesign(moonshotStore()))[0]?.design ?? "", /One module, one test/);
      assert.equal((await withDesign(testStore()))[0]?.design, undefined);
    });

    test("a sound plan costs nothing beyond the one call", async () => {
      const store = testStore();
      const calls = callsFor({});

      await prepareMission({ store, calls, planOnly: true });

      assert.equal(calls.planInputs.length, 1);
      assert.equal(types(store).includes("plan_critiqued"), false);
    });
  });
});

// The failure mode: a closed mission's recollection entering `factsVerified` as ground
// truth with a URL beside it, and a granted mission's refused fetch leaving no trace a
// human could act on. Both are PLAN-NEXT 11.3's two halves at the composition root.
describe("the web grant in prepare", () => {
  const webFinding = {
    claim: "The endpoint is documented as /healthz",
    source: "https://docs.python.org/3/",
    sourceKind: "web" as const,
    confidence: "high" as const,
  };

  test("a closed mission's web-shaped finding never reaches the ledger", async () => {
    const store = testStore();
    const warnings: string[] = [];

    await prepareMission({
      store,
      calls: callsFor({ research: [aResearchResult({ findings: [webFinding] })] }),
      onWarn: (message) => warnings.push(message),
    });

    assert.deepEqual(store.state().mission.ledger.factsVerified, []);
    // Dropped visibly, or the brief quotes a claim nobody can trace.
    assert.match(warnings.join("\n"), /--research-web/);
  });

  test("a granted mission keeps it, since the call could actually fetch", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: ["docs.python.org"] }) }),
    ]);

    await prepareMission({
      store,
      calls: callsFor({ research: [aResearchResult({ findings: [webFinding] })] }),
    });

    assert.equal(store.state().mission.ledger.factsVerified.length, 1);
  });

  // The first real granted run wrote both of these, and every source string below is
  // copied from its log. A mission granted `nodejs.org` recorded three `"web"` findings
  // whose sources were the *refusals* it had just been handed, and a mission granted
  // `example.com` recorded twelve sourced to `nodejs.org` URLs it had only seen in search
  // snippets. Both are the citation-shaped recollection 11.3 exists to stop, one grant
  // along: the fetch never happened and the finding says it did.
  test("a granted mission drops a web finding it could not have fetched", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: ["nodejs.org"] }) }),
    ]);
    const warnings: string[] = [];
    const refused = (source: string) => ({ ...webFinding, source });

    await prepareMission({
      store,
      calls: callsFor({
        research: [
          aResearchResult({
            findings: [
              refused("WebFetch refusal for https://developer.mozilla.org/en-US/docs/Web/API/WebSocket"),
              refused("WebFetch refusal for https://undici.nodejs.org/#/docs/api/WebSocket"),
              refused(
                "WebSearch permission error, query 'MDN WebSocket constructor url protocols SyntaxError exc…'",
              ),
              refused(
                'https://developer.mozilla.org/en-US/docs/Web/API/WebSocket (fetch refused: "This mission\'s…")',
              ),
              refused("https://nodejs.org/api/globals.html"),
            ],
          }),
        ],
      }),
      onWarn: (message) => warnings.push(message),
    });

    // Only the host the mission actually granted survives. `undici.nodejs.org` is a
    // different machine from `nodejs.org` — `allowedFetchHost`'s exact match, which is the
    // rule the live fetch was refused under.
    assert.deepEqual(
      store.state().mission.ledger.factsVerified.map((fact) => fact.source.ref),
      ["https://nodejs.org/api/globals.html"],
    );
    assert.match(warnings.join("\n"), /--domain/);
  });

  test("a granted mission drops a search-snippet URL outside its allowlist", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: ["example.com"] }) }),
    ]);

    await prepareMission({
      store,
      calls: callsFor({
        research: [
          aResearchResult({
            findings: [
              { ...webFinding, source: "https://nodejs.org/en/blog/announcements/v22-release-announce" },
              { ...webFinding, source: "https://nodejs.org/en/blog/release/v22.0.0" },
            ],
          }),
        ],
      }),
    });

    assert.deepEqual(store.state().mission.ledger.factsVerified, []);
  });

  // `raiseSecrets`' rule: a missing grant is a question, never a stop. The mission
  // planned and finished; the host arrives in the inbox as one advisory item.
  test("a denied fetch arrives as one advisory question and stops nothing", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: [] }) }),
    ]);

    const result = await prepareMission({
      store,
      calls: callsFor({
        research: [aResearchResult({ deniedHosts: ["evil.example", "evil.example"] })],
      }),
    });

    assert.equal(result.ok, true);
    const asked = store.inputs.filter((event) => event.type === "question_asked");
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0]), /--domain evil\.example/);
    assert.equal((asked[0] as { advisory?: boolean }).advisory, true);
    assert.deepEqual((asked[0] as { blocks?: string[] }).blocks, []);
  });

  test("a mission that was refused nothing asks nothing", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: ["docs.python.org"] }) }),
    ]);

    await prepareMission({ store, calls: callsFor({}) });

    assert.equal(store.inputs.some((event) => event.type === "question_asked"), false);
  });
});

// The scan (§2b) is the same decision point at a cheaper depth, and it was the half with
// no gate: the first real VPS mission ran `research: "closed"` and its `scan_completed`
// carried three `"web"` findings citing `nodejs.org` and MDN, which then entered
// `factsVerified` before intake asked its first question. Filtering the deep pass alone
// leaves the recollection in the ledger the deep pass appends to.
describe("the web grant covers the scan and the send-back research", () => {
  const webFinding = {
    claim: "node:test reports TAP by default",
    source: "https://nodejs.org/api/test.html",
    sourceKind: "web" as const,
    confidence: "high" as const,
  };

  test("a closed mission's scan finding reaches neither the event nor the ledger", async () => {
    const store = testStore();
    const warnings: string[] = [];

    await prepareMission({
      store,
      calls: callsFor({ scan: aScanResult({ findings: [webFinding] }) }),
      onWarn: (message) => warnings.push(message),
    });

    const scanned = store.inputs.find((event) => event.type === "scan_completed");
    assert.deepEqual((scanned as { findings: unknown[] }).findings, []);
    // The deep pass's own (codebase) finding is legitimate and stays; nothing sourced to
    // a URL this mission could not fetch is in the ledger the architect and planner read.
    assert.equal(
      store.state().mission.ledger.factsVerified.some((fact) => fact.source.ref.startsWith("http")),
      false,
    );
    assert.match(warnings.join("\n"), /--research-web/);
  });

  test("a granted scan keeps the host it was granted and drops the one it was not", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ research: "web", domains: ["nodejs.org"] }) }),
    ]);

    await prepareMission({
      store,
      calls: callsFor({
        scan: aScanResult({
          findings: [webFinding, { ...webFinding, source: "https://undici.nodejs.org/#/docs/api/Fetch" }],
        }),
      }),
    });

    const refs = store.state().mission.ledger.factsVerified.map((fact) => fact.source.ref);
    assert.ok(refs.includes("https://nodejs.org/api/test.html"));
    // `undici.nodejs.org` is a different machine, which is the rule the live fetch is
    // refused under.
    assert.equal(refs.includes("https://undici.nodejs.org/#/docs/api/Fetch"), false);
  });

  // The send-back path: a quick mission whose plan was refused buys the deep research it
  // skipped, and that answer went to the ledger with no gate of its own.
  test("the research a send-back buys is grounded too", async () => {
    const store = testStore([missionCreated({ quick: true })]);
    let asked = 0;
    const human: HumanPort = {
      askIntake: async () => [],
      awaitSignoff: async () =>
        asked++ === 0 ? { kind: "revise", feedback: "smaller steps" } : { kind: "approve" },
    };

    const calls = callsFor({
      // Criteria on the scan, so the quick mission's spec is accepted and the only deep
      // call is the one the send-back buys.
      scan: aScanResult({ brief: "small job", criteria: [aCriterion()] }),
      research: [aResearchResult({ findings: [webFinding] })],
    });

    await prepareMission({ store, calls, human });

    assert.deepEqual(calls.depths, ["scan", "deep"]);
    assert.deepEqual(store.state().mission.ledger.factsVerified, []);
  });
});
