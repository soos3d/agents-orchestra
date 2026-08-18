// The model itself is not testable for free; the boundary around it is, and the
// boundary is what breaks. These drive the real `Calls` implementation through a
// fake transport and assert the three rules from §3: structured return validated at
// the edge, exactly one reformat attempt, and spend recorded as measured.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Spend } from "../domain/budget.js";
import { aCriterion, aPlannedTask, aProgressLedger, anAgentSpec } from "../testing/fixtures.js";
import {
  createAgentCalls,
  CallFormatError,
  MAX_TURNS,
  PROGRESS_MODEL,
  queryOptions,
  readableDirectories,
  type RunQuery,
  checkAuthoring,
  judgeSystemPrompt,
  researchAuthoring,
  researchSystemPrompt,
  webFetchDecision,
  RESEARCH_MAX_TURNS,
  RESEARCH_WEB_TOOLS,
} from "./agentCalls.js";
import { PANEL_LENSES } from "./criteria.js";
import { judgeLens } from "./prompts.js";
import { type ProgressInput } from "./calls.js";

const config = { orchestratorModel: "fable", cwd: "/work/repo" };

// The defect these exist for: `allowedTools: []` reads like "no tools" and is not.
// The SDK defines it as the auto-approve list — the restriction is `tools`. With the
// wrong one, every decision point carried the whole Claude Code toolset, a `research`
// prompt naming a file made the model reach for Read, and `maxTurns: 1` ended the
// call as `error_max_turns` with no answer. §3's "no tools" rule was a comment.
describe("queryOptions", () => {
  test("disables every built-in tool, which is the rule the file claims", () => {
    assert.deepEqual(queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }).tools, []);
  });

  test("does not reach for the auto-approve list to do a restriction's job", () => {
    assert.equal("allowedTools" in queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }), false);
  });

  // `maxTurns: 1` reads as "one question, one answer" and counts something else: a
  // real `research` call died `error_max_turns` at num_turns 2 with nothing produced,
  // because a long structured answer spans more turns than it was given. With no
  // tools there is no loop to interrupt, so the cap is a backstop set clear of a
  // legitimate answer — the ceiling that binds is the mission's wall-clock budget.
  test("leaves a long structured answer room to finish", () => {
    const turns = queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }).maxTurns;

    assert.equal(turns, MAX_TURNS);
    assert.ok(turns > 1, "a one-turn cap fires on answers that were never going to loop");
  });

  // Repo settings and CLAUDE.md would put whatever is in the repo into every
  // decision point's context — the growth the loop architecture exists to avoid.
  test("loads no settings sources", () => {
    assert.deepEqual(queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }).settingSources, []);
  });

  test("grants exactly the tools a call asks for", () => {
    const options = queryOptions({ systemPrompt: "s", prompt: "p", model: "opus", tools: ["Read"] });

    assert.deepEqual(options.tools, ["Read"]);
  });

  // Defect 40. A judge with `Read` and a correct absolute path still had every open
  // refused, because the path was outside the process cwd. The SDK's option for it is
  // `additionalDirectories`, and the name is asserted here for the same reason
  // `allowedTools` is above: getting it wrong fails silently and looks like a model
  // that would not read.
  test("passes the readable directories a judge needs, under the SDK's own name", () => {
    const options = queryOptions({
      systemPrompt: "s",
      prompt: "p",
      model: "opus",
      tools: ["Read"],
      directories: ["/work/wt/src"],
    });

    assert.deepEqual(options.additionalDirectories, ["/work/wt/src"]);
  });

  test("omits the field entirely when there is nowhere extra to read", () => {
    assert.equal(
      "additionalDirectories" in queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }),
      false,
    );
  });

  // P3. Every decision point briefs on the mission's repository, and with no `cwd` the
  // SDK uses the orchestrator's own process directory — so a run started from anywhere
  // but the target repo had `judge` reading, and `research` reasoning about, whatever
  // directory the terminal happened to be in. The option *name* is asserted for the
  // same reason `allowedTools` and `additionalDirectories` are: a wrong one is
  // accepted silently and reads as a model that would not do its job.
  test("runs the call in the directory it was given, under the SDK's own name", () => {
    const options = queryOptions({ systemPrompt: "s", prompt: "p", model: "opus", cwd: "/work/repo" });

    assert.equal(options.cwd, "/work/repo");
  });

  test("omits cwd entirely when none was discovered", () => {
    assert.equal("cwd" in queryOptions({ systemPrompt: "s", prompt: "p", model: "opus" }), false);
  });
});

// The other half of P3, and the one a type could hide: `createAgentCalls` receives the
// whole `DiscoveredConfig`, and the repo was dropped at the `Pick` — so every call site
// looked correct while nothing downstream could know where the mission lives.
describe("createAgentCalls and the target repo", () => {
  const runSpy = () => {
    const seen: { cwd?: string }[] = [];
    const runQuery: RunQuery = async (input) => {
      seen.push({ ...(input.cwd === undefined ? {} : { cwd: input.cwd }) });
      return {
        text: JSON.stringify({ questions: [] }),
        spend: { tokens: { measured: 0, estimated: 0, unmeasured: 0 }, wallMs: 0, dispatches: 1 },
      };
    };
    return { seen, runQuery };
  };

  test("passes the discovered repo root to the call", async () => {
    const spy = runSpy();
    const calls = createAgentCalls({
      config: { orchestratorModel: "opus", cwd: "/anywhere", repoRoot: "/work/repo" },
      runQuery: spy.runQuery,
    });

    await calls.intake({ goal: "g", scan: { findings: [], ambiguities: [] } } as never);

    assert.deepEqual(spy.seen, [{ cwd: "/work/repo" }]);
  });

  // No git repo is a supported configuration (`discoverConfig` falls back to `cwd`),
  // and a mission run in a plain directory still has one.
  test("falls back to the discovered cwd when the mission is not in a repo", async () => {
    const spy = runSpy();
    const calls = createAgentCalls({
      config: { orchestratorModel: "opus", cwd: "/work/plain" },
      runQuery: spy.runQuery,
    });

    await calls.intake({ goal: "g", scan: { findings: [], ambiguities: [] } } as never);

    assert.deepEqual(spy.seen, [{ cwd: "/work/plain" }]);
  });
});

describe("readableDirectories", () => {
  test("is the set of directories holding the artifacts, deduplicated", () => {
    assert.deepEqual(
      readableDirectories(["/a/b/one.js", "/a/b/two.js", "/a/three.md"]),
      ["/a/b", "/a"],
    );
  });

  // `additionalDirectories` wants absolute paths, and by the time one reaches here
  // `artifactPaths` has resolved everything it could against the check's cwd. A
  // leftover relative path would resolve against the process cwd, which is the
  // directory this whole chain of defects was about.
  test("drops a relative path rather than resolving it somewhere arbitrary", () => {
    assert.deepEqual(readableDirectories(["notes.md", "/a/b/one.js"]), ["/a/b"]);
  });

  test("grants nothing when the judge was handed nothing", () => {
    assert.deepEqual(readableDirectories([]), []);
  });
});

// §3 says a judge reads artifacts rather than the worker's report, and `JudgeInput`
// hands it `artifactPaths`. With no tools it could not open them: against a real
// model the judge returned "the rubric requires direct verification by reading
// specs.md, ROADMAP.md, and RISKS.md" and failed the criterion — correct of it, and
// a contradiction in the code. Judge is the one decision point the spec itself
// exempts, so the exemption is explicit, read-only, and asserted here.
describe("the judge's exemption from the no-tools rule", () => {
  test("can read, and cannot write", async () => {
    const { run, seen } = transport([
      JSON.stringify({ met: true, evidence: aJudgeEvidence() }),
    ]);

    await createAgentCalls({ config, runQuery: run }).judge(aJudgeInput());

    const tools = seen.tools[0]!;
    assert.ok(tools.includes("Read"), "a judge that cannot read cannot grade artifacts");
    for (const forbidden of ["Write", "Edit", "Bash", "NotebookEdit"]) {
      assert.equal(tools.includes(forbidden), false, `judge must not be granted ${forbidden}`);
    }
  });

  test("gets the turns a read loop needs, unlike the calls that never loop", async () => {
    const { run, seen } = transport([
      JSON.stringify({ met: true, evidence: aJudgeEvidence() }),
      JSON.stringify(aProgressLedger()),
    ]);
    const calls = createAgentCalls({ config, runQuery: run });

    await calls.judge(aJudgeInput());
    await calls.progress(aProgressInput());

    assert.ok(
      seen.maxTurns[0]! > seen.maxTurns[1]!,
      "reading N artifacts takes more turns than answering from the prompt",
    );
  });

  // Defect 40, and the third layer of one wound: 22 gave the judge tools, 33 and 39
  // gave it paths that resolve, and it still could not open them. A task's artifacts
  // live in its worktree, which is not under the orchestrator's cwd, and the SDK
  // refuses a `Read` outside it — so a real judge answered "every Read call failed
  // with a permission error", returned `met: false`, and failed correct work. The
  // only honest answer available to it, from an impossible position.
  test("is granted the directories the artifacts it was handed live in", async () => {
    const { run, seen } = transport([JSON.stringify({ met: true, evidence: aJudgeEvidence() })]);

    await createAgentCalls({ config, runQuery: run }).judge({
      ...aJudgeInput(),
      artifactPaths: ["/work/wt/src/clamp.js", "/work/wt/src/index.js", "/work/wt/NOTES.md"],
    });

    // The directories of those files and nothing wider: the grant is exactly what this
    // criterion is about, so a judge cannot wander.
    assert.deepEqual(seen.directories[0], ["/work/wt/src", "/work/wt"]);
  });

  test("every other decision point still gets none", async () => {
    const { run, seen } = transport([JSON.stringify(aProgressLedger())]);

    await createAgentCalls({ config, runQuery: run }).progress(aProgressInput());

    assert.deepEqual(seen.tools[0], []);
    assert.deepEqual(seen.directories[0], [], "a call with no tools has nothing to grant");
  });
});

const someSpend = (): Spend => ({
  tokens: { measured: 1200, estimated: 0, unmeasured: 0 },
  wallMs: 900,
  dispatches: 1,
});

interface Recorded {
  prompts: string[];
  models: string[];
  systemPrompts: string[];
  tools: string[][];
  maxTurns: number[];
  directories: (readonly string[])[];
}

/** Answers in order, recording what it was asked. */
function transport(answers: readonly string[]): { run: RunQuery; seen: Recorded } {
  const seen: Recorded = {
    prompts: [],
    models: [],
    systemPrompts: [],
    tools: [],
    maxTurns: [],
    directories: [],
  };
  let index = 0;

  const run: RunQuery = async ({ prompt, model, systemPrompt, tools, maxTurns, directories }) => {
    seen.prompts.push(prompt);
    seen.models.push(model);
    seen.systemPrompts.push(systemPrompt);
    seen.tools.push(tools ?? []);
    seen.maxTurns.push(maxTurns ?? 0);
    seen.directories.push(directories ?? []);
    const text = answers[index++];
    if (text === undefined) throw new Error(`transport ran out of answers at call ${index}`);
    return { text, spend: someSpend() };
  };

  return { run, seen };
}

const aJudgeEvidence = () => ({
  artifactIds: ["a1"],
  checkOutput: "the table has 9 rows",
  reasoning: "every HIGH risk in the source appears exactly once",
  byTask: ["t1"],
});

const aJudgeInput = () => ({
  criterion: aCriterion({ check: { kind: "judge" as const, rubric: "one row per risk" } }),
  check: { kind: "judge" as const, rubric: "one row per risk" },
  artifactPaths: ["/work/RISKS.md"],
});

const aProgressInput = (): ProgressInput => ({
  criteria: [aCriterion()],
  reports: [],
  recentProgress: [],
  counters: { round: 1, stalls: 0, resets: 0 },
  frontier: [],
});

// The defect: every decision-point prompt ended with "Answer with a single JSON
// object" and never said which one. Against a real model the `research` call came
// back with `guesses` as an array of strings and a `confidence` outside the enum —
// shapes nobody could have guessed, because `Guess` carries an id, a basis, and an
// addedRound. One reformat attempt carrying a zod error is not a substitute for
// having said the shape the first time.
describe("the schema in the prompt", () => {
  test("carries the call's own field names and enums", async () => {
    const { run, seen } = transport([JSON.stringify(aProgressLedger())]);

    await createAgentCalls({ config, runQuery: run }).progress(aProgressInput());

    const system = seen.systemPrompts[0]!;
    assert.match(system, /isRequestSatisfied/);
    assert.match(system, /unmetCriteria/);
  });

  test("names the enum a real model got wrong by inventing a value", async () => {
    const { run, seen } = transport([
      JSON.stringify({ brief: "b", findings: [], confidence: "high" }),
    ]);

    await createAgentCalls({ config, runQuery: run }).research({
      question: "q",
      sources: ["codebase"],
      depth: "deep",
    });

    assert.match(seen.systemPrompts[0]!, /"high"[\s\S]*"medium"[\s\S]*"low"/);
  });

  // `criteria` is deliberately `unknown[]` so an uncheckable criterion stays
  // representable for `writeOutcomeSpec` to reject. That must not make the schema
  // unrenderable — it renders as an unconstrained array and the gate still runs.
  test("survives the deliberately-untyped criteria field", async () => {
    const { run, seen } = transport([
      JSON.stringify({ brief: "b", findings: [], confidence: "low" }),
    ]);

    await createAgentCalls({ config, runQuery: run }).research({
      question: "q",
      sources: ["codebase"],
      depth: "deep",
    });

    assert.match(seen.systemPrompts[0]!, /criteria/);
  });

  // `criteria: unknown[]` renders as an unconstrained array, so the derived schema
  // tells the model nothing about a criterion — and against a real model that
  // produced seven criteria in a row with `check.kind: "command"` and no `command`,
  // rejected by the spec gate one after another. The type stays `unknown[]` (that is
  // what keeps an uncheckable criterion representable, §4); the *prompt* stops being
  // silent about the shape.
  test("spells out the criterion shape the untyped field cannot", async () => {
    const { run, seen } = transport([
      JSON.stringify({ brief: "b", findings: [], confidence: "low" }),
    ]);

    await createAgentCalls({ config, runQuery: run }).research({
      question: "q",
      sources: ["codebase"],
      depth: "deep",
    });

    const system = seen.systemPrompts[0]!;
    // Every arm of VerifySpec, and the field each one requires.
    assert.match(system, /"command"/);
    assert.match(system, /"judge"/);
    assert.match(system, /rubric/);
    assert.match(system, /statement/);
  });

  test("still says the rules the schema cannot express", async () => {
    const { run, seen } = transport([
      JSON.stringify({ brief: "b", findings: [], confidence: "low" }),
    ]);

    await createAgentCalls({ config, runQuery: run }).research({
      question: "q",
      sources: ["codebase"],
      depth: "deep",
    });

    // A criterion with no check is the system's most important validation (§4).
    assert.match(seen.systemPrompts[0]!, /check/);
  });
});

describe("createAgentCalls", () => {
  test("returns the validated value when the model answers cleanly", async () => {
    const { run } = transport([JSON.stringify(aProgressLedger({ instruction: "keep going" }))]);
    const calls = createAgentCalls({ config, runQuery: run });

    const ledger = await calls.progress(aProgressInput());

    assert.equal(ledger.instruction, "keep going");
  });

  // Models wrap JSON in prose and fences more often than not; a reformat round trip
  // to strip ``` would cost a call and teach nothing.
  test("accepts an answer wrapped in prose and a fenced block", async () => {
    const { run, seen } = transport([
      `Here's my read on the round:\n\n\`\`\`json\n${JSON.stringify(aProgressLedger())}\n\`\`\`\nHope that helps.`,
    ]);
    const calls = createAgentCalls({ config, runQuery: run });

    await calls.progress(aProgressInput());

    assert.equal(seen.prompts.length, 1);
  });

  describe("the structured-return boundary", () => {
    test("asks for a reformat exactly once, and accepts the second answer", async () => {
      const { run, seen } = transport([
        "I think it's going fine, honestly.",
        JSON.stringify(aProgressLedger({ isInLoop: true })),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const ledger = await calls.progress(aProgressInput());

      assert.equal(ledger.isInLoop, true);
      assert.equal(seen.prompts.length, 2);
      assert.match(seen.prompts[1] ?? "", /Your last answer was rejected/);
    });

    test("tells the retry what was wrong with the first answer", async () => {
      const { run, seen } = transport([
        JSON.stringify({ isRequestSatisfied: "yes please" }),
        JSON.stringify(aProgressLedger()),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.progress(aProgressInput());

      assert.match(seen.prompts[1] ?? "", /isRequestSatisfied/);
    });

    // A second reformat would let a model that cannot follow the schema spend the
    // mission's budget on retries.
    test("does not ask a third time", async () => {
      const { run, seen } = transport(["nope", "still nope"]);
      const calls = createAgentCalls({ config, runQuery: run });

      const error = await calls.progress(aProgressInput()).catch((e: unknown) => e);

      assert.ok(error instanceof CallFormatError);
      assert.equal(error.call, "progress");
      assert.equal(seen.prompts.length, 2);
      assert.match(error.message, /cannot continue on an unparseable answer/);
    });

    // P4. "did not return its schema" says the answer did not parse and never says
    // what it was, so the one thing that identifies the cause — a refusal, a wrapped
    // fence, a truncation — was discarded at the point of failure. A worker report
    // has carried its raw text since Phase 1a for the same reason.
    test("quotes what the model actually said", async () => {
      const { run } = transport(["nope", "still nope"]);
      const calls = createAgentCalls({ config, runQuery: run });

      const error = (await calls.progress(aProgressInput()).catch((e: unknown) => e)) as CallFormatError;

      assert.match(error.message, /still nope/);
      assert.equal(error.raw, "still nope");
    });

    test("bounds a long reply rather than putting the whole transcript in an error", async () => {
      const long = `${"x".repeat(9_000)}THE-END`;
      const { run } = transport([long, long]);
      const calls = createAgentCalls({ config, runQuery: run });

      const error = (await calls.progress(aProgressInput()).catch((e: unknown) => e)) as CallFormatError;

      assert.ok(error.message.length < 6_000, "the message carries a tail, not the reply");
      // The tail, because the end of a reply is where a truncation shows.
      assert.match(error.message, /THE-END$/);
    });
  });

  describe("each decision point validates its own return", () => {
    test("research rejects a finding with no source", async () => {
      const bad = { brief: "b", confidence: "high", findings: [{ claim: "it is so" }] };
      const good = { brief: "b", confidence: "high", findings: [] };
      const { run } = transport([JSON.stringify(bad), JSON.stringify(good)]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.research({ question: "q", sources: ["memory"], depth: "scan" });

      assert.deepEqual(result.findings, []);
    });

    // Criteria stay untyped through this boundary on purpose: writeOutcomeSpec is
    // what rejects an uncheckable one, and a schema here would make that case
    // unrepresentable and its test impossible.
    test("research passes an uncheckable criterion through to the spec gate", async () => {
      const { run } = transport([
        JSON.stringify({
          brief: "b",
          confidence: "low",
          findings: [],
          criteria: [{ id: "c1", statement: "make it nicer" }],
        }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.research({ question: "q", sources: ["web"], depth: "deep" });

      assert.equal(result.criteria?.length, 1);
    });

    // Defect 44's other half. The tokenizer now behaves exactly like a shell, which
    // means a check written with `\n` between statements fails to parse — correctly,
    // and just as loudly as before. The only way that stops costing missions is if the
    // calls that author a `command` check are told the argument is passed verbatim.
    // Four of them since PLAN-NEXT 5.1 — the outcome spec moved to `architect`, and a
    // call that writes criteria writes checks. A real mission wrote `python3 -c "import sys;\nfor a in ...:"`, which
    // no shell would have run either, and the criterion could never be met.
    test("tells every call that authors a check that arguments are passed verbatim", async () => {
      const { run, seen } = transport([
        JSON.stringify({ brief: "b", confidence: "low", findings: [], criteria: [] }),
        JSON.stringify({ criteria: [aCriterion()], designNote: "# Design" }),
        JSON.stringify({ tasks: [aPlannedTask()] }),
        JSON.stringify(anAgentSpec()),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.research({ question: "q", sources: ["web"], depth: "deep" });
      await calls.architect({ goal: "g", brief: "b", findings: [] });
      await calls.plan({ goal: "g", ledger: aProgressInput() as never, envelope: {} as never });
      await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: ["Read"],
        transports: ["cli"],
        targets: ["claude"],
        models: [],
      });

      assert.equal(seen.systemPrompts.length, 4);
      for (const prompt of seen.systemPrompts) {
        assert.match(prompt, /exactly\s+as written/, "a check-authoring call was not told");
        // The concrete consequence, not just the rule — a model that is told "no shell"
        // still reads `\n` as a line break, because in most contexts it is one.
        assert.match(prompt, /line\s+break/);
        // The 2026-08-18 calculator run, and the same lesson one field along: a check is
        // graded on its exit code and nothing reads its output. That mission's criteria were
        // authored as `node -e "console.log(cond ? 'true' : 'false')"`, which exits 0
        // whatever it decides — `criterion_checked` recorded `met: true` against a
        // `checkOutput` of `exit 0\nfalse`, and four of six command criteria could not fail.
        // `writeOutcomeSpec` refuses that shape now; this is the half that stops it being
        // written, and the two ship together because a prompt and its validation always do.
        assert.match(prompt, /exit\s+non-zero/, "a check-authoring call was not told to fail loudly");
        // The mechanism, not just the instruction — `process.exit(ok ? 0 : 1)` is the fix
        // the refusal message names, so the prompt and the send-back say the same thing.
        assert.match(prompt, /process\.exit\(ok \? 0 : 1\)/);
      }
    });

    // PLAN-NEXT 5.1. The architect writes two things and only one of them is validated by
    // a later gate: an answer with criteria and no design note passes `writeOutcomeSpec`
    // and leaves every worker without the one document that says what the whole change
    // is. So the schema requires it, here, where the reformat attempt can still fix it.
    test("architect returns the outcome spec and a design note, and refuses to skip the note", async () => {
      const { run } = transport([
        JSON.stringify({ criteria: [aCriterion()], designNote: "# Design\n\nOne module." }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(result.criteria?.length, 1);
      assert.match(result.designNote, /One module/);
    });

    // A real run on 2026-08-16 returned a design note whose headings and bullets were
    // separated by spaces: 1,696 characters on one line, which is a document nobody can
    // read. Nothing about it is invalid, so there is nothing to reject — the fix is that
    // the call is told what a line break is inside a JSON string.
    test("the architect is told its note needs real line breaks", async () => {
      const { run, seen } = transport([JSON.stringify({ criteria: [aCriterion()], designNote: "# D" })]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.match(seen.systemPrompts[0]!, /real line breaks/);
    });

    // PLAN-NEXT 7.2. Mock-first is a convention and its whole enforcement is this
    // paragraph, so a prompt that lost it would be a stage silently undone — the plan
    // would go back to putting the live integration first and every worker would be
    // asked to do it with no credentials and no network.
    test("the architect is told to design against mocks and to name env vars", async () => {
      const { run, seen } = transport([JSON.stringify({ criteria: [aCriterion()], designNote: "# D" })]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.architect({ goal: "g", brief: "b", findings: [] });

      const prompt = seen.systemPrompts[0]!;
      assert.match(prompt, /mocks first/i);
      assert.match(prompt, /last\* task/, "the real integration was not put last");
      assert.match(prompt, /envVars/);
      // The half a leak would come through: a model that reads this as "list what the
      // integration needs" and writes the key itself.
      assert.match(prompt, /Never a value/);
    });

    // The schema is the second half of that pair (PLAN-NEXT 7.1). A model that answers
    // `STRIPE_KEY=sk_live_…` would put a live key into `secret_required` and into the
    // question raised beside it, so the boundary refuses it rather than trusting the
    // sentence above.
    test("an envVars entry carrying a value is refused at the boundary", async () => {
      const { run, seen } = transport([
        JSON.stringify({ criteria: [aCriterion()], designNote: "# D", envVars: ["STRIPE_KEY=sk_live_9d8"] }),
        JSON.stringify({ criteria: [aCriterion()], designNote: "# D", envVars: ["STRIPE_KEY"] }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(seen.prompts.length, 2, "a name=value pair was accepted");
      assert.deepEqual(result.envVars, ["STRIPE_KEY"]);
    });

    test("an architect answer with no design note is sent back once", async () => {
      const { run, seen } = transport([
        JSON.stringify({ criteria: [aCriterion()] }),
        JSON.stringify({ criteria: [aCriterion()], designNote: "# Design" }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(seen.prompts.length, 2, "the missing design note was accepted");
      assert.match(seen.prompts[1]!, /rejected/);
      assert.equal(result.designNote, "# Design");
    });

    // Two live missions died here. `criteria` was optional on this schema, so an answer
    // that omitted it was *valid* — and `prepare.ts`'s `writeOutcomeSpec(second.criteria ??
    // [], …)` then refused it as "no criteria, nothing to verify", twice, and the mission
    // ended having written a design note and no contract. Both a Qwen and a DeepSeek card
    // did it, so it is the schema and not the card: the model was shown a shape that
    // permits exactly what the next step forbids, which is the standing rule about a prompt
    // and its validation moving together, one layer down.
    //
    // Sent back *here* rather than refused there for the same reason the design note is: a
    // reformat is one cheap call inside `ask`, and an architect round trip at the prepare
    // layer is a whole decision point — up to five minutes on a slow card, twice.
    test("an architect answer with no criteria is sent back once", async () => {
      const { run, seen } = transport([
        JSON.stringify({ designNote: "# Design" }),
        JSON.stringify({ criteria: [aCriterion()], designNote: "# Design" }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(seen.prompts.length, 2, "an answer with no criteria was accepted");
      assert.equal(result.criteria?.length, 1);
    });

    // An empty array is the same answer spelled differently, and it arrived from a real
    // card as `criteria: []` beside a design note that described three of them.
    test("an architect answer with an empty criteria array is sent back too", async () => {
      const { run, seen } = transport([
        JSON.stringify({ criteria: [], designNote: "# Design" }),
        JSON.stringify({ criteria: [aCriterion()], designNote: "# Design" }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(seen.prompts.length, 2, "an empty criteria array was accepted");
    });

    // The criteria stay an open array here for the reason they were open on `research`:
    // an uncheckable criterion has to *reach* `writeOutcomeSpec` to be refused by it, and
    // a schema that dropped it at the boundary would make the system's most important
    // validation untestable.
    test("architect criteria are not typed shut at the boundary", async () => {
      const { run } = transport([
        JSON.stringify({ criteria: [{ id: "c1", statement: "make it nicer" }], designNote: "# D" }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.architect({ goal: "g", brief: "b", findings: [] });

      assert.equal(result.criteria?.length, 1);
    });

    // PLAN-NEXT 5.3. An empty list is the answer a sound plan gets and the answer the
    // critic should give most of the time — a schema that refused it would buy a reformat
    // call to be told the same thing.
    test("critique may object to nothing", async () => {
      const { run } = transport([JSON.stringify({ objections: [] })]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.critique({ goal: "g", tasks: [aPlannedTask()], criteria: [] });

      assert.deepEqual(result.objections, []);
    });

    test("critique returns objections against a task, and no plan of its own", async () => {
      const { run, seen } = transport([
        JSON.stringify({
          objections: [
            { kind: "colliding-lease", detail: "t1 and t2 both write src/api.ts", taskId: "t2" },
          ],
        }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.critique({
        goal: "g",
        tasks: [aPlannedTask({ id: "t1" }), aPlannedTask({ id: "t2" })],
        criteria: [aCriterion()],
      });

      assert.equal(result.objections[0]?.taskId, "t2");
      assert.equal("tasks" in result, false, "the critic returned a plan; that is the planner's job");
      // No tools, like every decision point but `judge` — the critic argues with what the
      // prompt carries, which is what makes it staffable to a chat completion at all.
      assert.deepEqual(seen.tools[0], []);
    });

    test("plan returns tasks, and may carry a proposed criteria change", async () => {
      const { run } = transport([
        JSON.stringify({ tasks: [aPlannedTask()], criteria: [aCriterion()] }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.plan({
        goal: "g",
        ledger: { ...aProgressInput(), criteria: [] } as never,
        envelope: {} as never,
      });

      assert.equal(result.tasks[0]?.id, "t1");
      assert.equal(result.criteria?.length, 1);
    });

    // PLAN-NEXT 3.2, and the standing rule that a prompt and its validation move
    // together: `inspectContainment` refuses a spec that asks to run outside the
    // mission's container, so the call that writes the spec has to know the field exists
    // and that setting it is not a choice it gets to make.
    test("synthesize is told containment is the mission's decision, not the task's", async () => {
      const { run, seen } = transport([JSON.stringify(anAgentSpec())]);

      await createAgentCalls({ config, runQuery: run }).synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: ["Read"],
        transports: ["cli"],
        targets: ["claude"],
        models: [],
      });

      const system = seen.systemPrompts[0]!;
      assert.match(system, /containment/);
      assert.match(system, /refused at\s+validation/);
    });

    test("synthesize returns an agent spec", async () => {
      const { run } = transport([JSON.stringify(anAgentSpec({ role: "invoice-reconciler" }))]);
      const calls = createAgentCalls({ config, runQuery: run });

      const spec = await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: [],
        transports: ["cli"],
        targets: ["claude"],
        models: [],
      });

      assert.equal(spec.role, "invoice-reconciler");
    });

    // The two ceilings synthesis validates against have to *reach* the model, or the
    // first answer is always a misunderstanding and the retry does the teaching. This
    // is the file the fixture harness substitutes for, so what the model receives is
    // asserted here or nowhere.
    test("hands synthesis the resolved catalogue and the lease rule", async () => {
      const { run, seen } = transport([JSON.stringify(anAgentSpec())]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: ["Read", "Glob"],
        transports: ["cli"],
        targets: ["claude"],
        models: [],
      });

      assert.match(seen.prompts[0]!, /Read/);
      assert.match(seen.prompts[0]!, /Glob/);
      assert.match(seen.systemPrompts[0]!, /toolCatalogue/);
      assert.match(seen.systemPrompts[0]!, /owns/);
      // The schema is rendered into the prompt, so `owns` cannot be described in prose
      // and absent from the shape the boundary will reject.
      assert.match(seen.systemPrompts[0]!, /"owns"/);
    });

    // The prompt-and-validation rule, for the card menu. `modelCards` widens nothing —
    // `models` is still the allowlist — so the prompt has to say that, or a model reads
    // a list of ids beside a list of ids and picks from the wrong one. The card menu
    // itself reaching the call is asserted at the seam in `synthesize.test.ts`.
    test("says the card menu is a reference and not a second allowlist", async () => {
      const { run, seen } = transport([JSON.stringify(anAgentSpec())]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: ["Read"],
        transports: ["cli"],
        targets: ["claude"],
        models: ["sonnet"],
        modelCards: "- some/model (worker, 128k context, $1/$2 per 1M in/out) via nebius",
      });

      assert.match(seen.prompts[0]!, /some\/model/);
      assert.match(seen.systemPrompts[0]!, /modelCards/);
      assert.match(seen.systemPrompts[0]!, /not a second allowlist/);
    });

    // Defect 22 one level up. §3 gives the judge artifact paths and nothing else, and
    // nothing told synthesis that — so against a real model three of four tasks came
    // back with a rubric grading "the final message", which no judge can open. Every
    // judge-verified task in that mission was unpassable however well it was done.
    test("tells synthesis that a judge reads files, not the worker's message", async () => {
      const { run, seen } = transport([JSON.stringify(anAgentSpec())]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: ["Read"],
        transports: ["cli"],
        targets: ["claude"],
        models: [],
      });

      const prompt = seen.systemPrompts[0]!;
      assert.match(prompt, /files on disk/);
      assert.match(prompt, /final message/);
      // The consequence, not just the rule: a document task has to write a file, or
      // there is nothing for the rubric to be about.
      assert.match(prompt, /leave\s*\n?a file behind/);
    });

    test("judge returns a verdict with evidence behind it", async () => {
      const { run } = transport([
        JSON.stringify({
          met: true,
          evidence: {
            artifactIds: ["a1"],
            checkOutput: "exit 0",
            reasoning: "the endpoint responds 200",
            byTask: ["t1"],
          },
        }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.judge({
        criterion: aCriterion(),
        check: { kind: "judge", rubric: "r" },
        artifactPaths: ["/tmp/a"],
      });

      assert.equal(result.met, true);
      assert.deepEqual(result.evidence.artifactIds, ["a1"]);
    });
  });

  describe("models and spend", () => {
    // §3: progress is a small structured judgment called more often than anything
    // else, so it does not run on the model that does the planning.
    test("progress runs on a cheaper model than the rest", async () => {
      const { run, seen } = transport([
        JSON.stringify(aProgressLedger()),
        JSON.stringify({ tasks: [] }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.progress(aProgressInput());
      await calls.plan({ goal: "g", ledger: {} as never, envelope: {} as never });

      assert.equal(seen.models[0], PROGRESS_MODEL);
      assert.equal(seen.models[1], "fable");
    });

    // The loop's own calls are the portion actually billed (§9.5), so they are
    // measured rather than counted as an unmeasured dispatch.
    test("records measured spend for every attempt, including the rejected one", async () => {
      const recorded: { call: string; spend: Spend }[] = [];
      const { run } = transport(["not json", JSON.stringify(aProgressLedger())]);
      const calls = createAgentCalls({
        config,
        runQuery: run,
        onSpend: (call, spend) => recorded.push({ call, spend }),
      });

      await calls.progress(aProgressInput());

      assert.equal(recorded.length, 2);
      assert.equal(recorded[0]?.call, "progress");
      assert.equal(recorded[0]?.spend.tokens.measured, 1200);
      assert.equal(recorded[0]?.spend.tokens.unmeasured, 0);
    });
  });

  test("carries the whole input into the prompt rather than summarizing it", async () => {
    const { run, seen } = transport([JSON.stringify(aProgressLedger())]);
    const calls = createAgentCalls({ config, runQuery: run });

    await calls.progress(aProgressInput());

    // A hand-written summary here would be a second, undeclared reducer over folded
    // state — and prompt building is supposed to be a pure function of it (§3).
    assert.match(seen.prompts[0] ?? "", /"round": 1/);
    assert.match(seen.prompts[0] ?? "", /GET \/health/);
    assert.match(seen.systemPrompts[0] ?? "", /isInLoop/);
  });
});

// The failure mode: a panel silently changing what a *quick* mission pays for. The
// lens is what makes a seat's prompt different, so "quick judge spend unchanged" is
// either an equality the suite holds or a number somebody remembers measuring once.
describe("judgeSystemPrompt", () => {
  test("no lens is the judge prompt a mission got before panels existed", () => {
    const base = judgeSystemPrompt();

    assert.equal(judgeSystemPrompt(undefined), base);
    assert.match(base, /You decide whether a mission criterion is met/);
    assert.doesNotMatch(base, /Your seat on this panel/);
  });

  test("a lens lands before the schema, which is last in every prompt in this file", () => {
    for (const lens of PANEL_LENSES) {
      const prompt = judgeSystemPrompt(lens);

      assert.ok(prompt.includes(judgeLens(lens)), `${lens} is not in its own seat's prompt`);
      assert.ok(
        prompt.indexOf(judgeLens(lens)) < prompt.indexOf("Answer with"),
        `${lens} lands after the schema instruction, where it reads as a note about JSON`,
      );
    }
  });

  // It arrives from the folded log. A log written by a newer build naming a lens this
  // one does not have must still be gradeable — the narrowing is what is lost, not the
  // verdict.
  test("an unknown lens is dropped rather than pasted in raw", () => {
    assert.equal(judgeSystemPrompt("vibes"), judgeSystemPrompt());
  });
});

// A prompt and its validation move together — and a real run proved that half of the
// pairing is a cost as well as a rule. The scanner paragraph first lived in the shared
// check-authoring constant, so every criteria-authoring call carried it; the architect on
// `Qwen/Qwen3-30B-A3B-Instruct-2507` then returned a design note and no criteria at all,
// twice, and the mission ended in `writeOutcomeSpec`. What is asserted here is that a
// mission granted no scanner sees the text it saw before 6.3 existed.
// A prompt and its validation move together. `repoKb` reaches both of these calls as an
// input field, so both system prompts have to say what it is — a map of one commit that
// the call cannot browse. Without the staleness half, a design written over the map calls
// a directory empty because nothing in it was committed yet.
describe("the repo map in the tool-less prompts", () => {
  test("research and the architect are both told what `repoKb` is", async () => {
    const seen: string[] = [];
    const calls = createAgentCalls({
      config,
      runQuery: async ({ systemPrompt }) => {
        seen.push(systemPrompt);
        return {
          text: JSON.stringify({
            criteria: [aCriterion()],
            designNote: "x",
            findings: [],
            brief: "",
            confidence: "high",
          }),
          spend: { tokens: { measured: 0, estimated: 0, unmeasured: 0 }, wallMs: 0, dispatches: 0 },
        };
      },
    });

    await calls.research({ question: "q", sources: ["codebase"], depth: "deep" });
    await calls.architect({ goal: "g", brief: "b", findings: [] });

    assert.equal(seen.length, 2);
    for (const prompt of seen) {
      assert.match(prompt, /`repoKb`, it is a map of one repository at one/);
      assert.match(prompt, /snapshot and not a listing/);
    }
  });
});

describe("the scanner offer in the criteria-authoring prompts", () => {
  const authoring = () => {
    const seen: string[] = [];
    const calls = createAgentCalls({
      config,
      runQuery: async ({ systemPrompt }) => {
        seen.push(systemPrompt);
        return {
          text: JSON.stringify({
            criteria: [aCriterion()],
            designNote: "x",
            findings: [],
            brief: "",
            confidence: "high",
          }),
          spend: { tokens: { measured: 0, estimated: 0, unmeasured: 0 }, wallMs: 0, dispatches: 0 },
        };
      },
    });
    return { seen, calls };
  };

  // The prose *and* the shape are conditional, and the second half is a correction.
  //
  // It was prose alone at first, on the reasoning that a narrowed schema is a second
  // criterion type to keep in step with the first and `writeOutcomeSpec` already refuses
  // what the prose does not offer. A real mission disproved the premise: granted no
  // scanner, the architect read `scanner` off the rendered union — where it was still a
  // legal-looking variant — wrote a deepsec check anyway, and seq 18 is the
  // `outcome_spec_rejected` that cost its one retry. The guard held and the offer was
  // wrong. Withholding the paragraph while still rendering the shape is half a refusal.
  //
  // The maintenance objection is answered by derivation rather than dismissed:
  // `criterionSchemaWithoutScanner` is `criterionSchema.extend`ed over shared union
  // members, so the two cannot drift. And the fix is a *removal* — the scanner paragraph
  // written unconditionally is what made Qwen return no criteria at all, so a prompt that
  // offers too much is corrected with less text, never with a sentence forbidding
  // something.
  test("a mission with no grant is shown no scanner, in prose or in shape", async () => {
    const { seen, calls } = authoring();

    await calls.research({ question: "q", sources: ["codebase"], depth: "deep" });
    await calls.architect({ goal: "g", brief: "b", findings: [] });

    assert.equal(seen.length, 2);
    for (const prompt of seen) {
      assert.doesNotMatch(prompt, /may also use a `scanner` check/);
      assert.doesNotMatch(prompt, /security criterion/);
      // The half that was missing: the rendered union must not name the variant either.
      assert.doesNotMatch(prompt, /scanner/i);
    }
  });

  // The other direction, or the narrowing is unpinned: a granted mission still gets the
  // variant in the shape it is being invited to use, not only in the paragraph.
  test("a granted mission is shown the scanner variant in the rendered union", async () => {
    const { seen, calls } = authoring();

    await calls.architect({ goal: "g", brief: "b", findings: [], scanners: ["deepsec"] });

    assert.match(seen[0]!, /"kind":\s*"scanner"|kind: "scanner"|scanner/);
    assert.match(seen[0]!, /minSeverity/);
  });

  // `research` writes the outcome spec only on a quick mission, which is the mission not
  // to spend a per-file security scan on. It is never offered one, grant or no grant.
  test("the offer reaches the architect and only the architect", async () => {
    const { seen, calls } = authoring();

    await calls.architect({ goal: "g", brief: "b", findings: [], scanners: ["deepsec"] });

    assert.match(seen[0]!, /may also use a `scanner` check/);
    assert.match(seen[0]!, /"scanner":"deepsec"/);
    assert.match(seen[0]!, /CRITICAL.*HIGH_BUG.*LOW/s);
    // Short, positive and concrete: the version that broke the model was none of those.
    assert.match(seen[0]!, /security criterion and nothing else/);
  });

  test("checkAuthoring is unchanged when nothing was granted", () => {
    assert.equal(checkAuthoring(), checkAuthoring([]));
    assert.doesNotMatch(checkAuthoring(), /scanner/i);
    assert.match(checkAuthoring(["deepsec"]), /deepsec/);
  });
});

// The failure mode this whole block exists for: a mission that granted no egress paying
// for a different prompt, different turn cap, or a tool it never approved — and a
// granted one whose tools are attached but whose prompt never says a source must be
// fetched. `agentCalls.ts` is below the fixture seam, so what the model *receives* is
// asserted here or nowhere (PLAN-NEXT 11.3).
describe("the web grant on the research call", () => {
  const spend: Spend = { tokens: { measured: 0, estimated: 0, unmeasured: 0 }, wallMs: 0, dispatches: 0 };
  const researched = () => {
    const seen: Parameters<RunQuery>[0][] = [];
    const calls = createAgentCalls({
      config,
      runQuery: async (input) => {
        seen.push(input);
        return {
          text: JSON.stringify({ brief: "b", findings: [], confidence: "high" }),
          spend,
        };
      },
    });
    return { seen, calls };
  };

  // The done-when the stage is measured against: an ungranted mission's prompt is the
  // one every model has been observed to answer, byte for byte.
  test("an ungranted mission's prompt is byte-identical to the one it had", () => {
    assert.equal(researchSystemPrompt(), researchSystemPrompt(undefined));
    assert.doesNotMatch(researchSystemPrompt(), /WebFetch|WebSearch|allowlist/);
    // Insertion-only: the granted prompt is the closed one with exactly the authoring
    // paragraph spliced in, so no word of the text a model has been measured on can be
    // edited under cover of adding the grant.
    assert.equal(
      researchSystemPrompt([]).replace(`\n\n${researchAuthoring([])}`, ""),
      researchSystemPrompt(),
    );
  });

  // `groundedFindings` drops a `"web"` finding sourced outside the allowlist, and a rule
  // enforced with no prompt saying so is a call whose honest answer is deleted without it
  // being told where the honest answer goes. `WebSearch` cannot be held to a host, so the
  // snippet-derived claim is legitimate research — it just is not a fetch.
  test("a granted mission is told where a search-derived claim goes", () => {
    const granted = researchAuthoring(["nodejs.org"]);

    assert.match(granted, /A search result is not a fetch/);
    assert.match(granted, /`guesses`/);
    assert.match(granted, /outside the allowlist/);
  });

  test("a closed mission gets no tools and the backstop turn cap", async () => {
    const { seen, calls } = researched();

    await calls.research({ question: "q", sources: ["codebase"], depth: "deep" });

    assert.deepEqual(seen[0]!.tools, []);
    assert.equal(seen[0]!.maxTurns, MAX_TURNS);
    assert.equal(seen[0]!.domains, undefined);
  });

  // Searching and then fetching what the search returned is a loop, and `MAX_TURNS` is
  // sized for a call that cannot loop: with the old backstop the call ends
  // `error_max_turns` having produced nothing on a legitimate answer.
  test("a granted mission gets exactly the two read-only tools and room to use them", async () => {
    const { seen, calls } = researched();

    await calls.research({
      question: "q",
      sources: ["web"],
      depth: "deep",
      web: { domains: ["docs.python.org"] },
    });

    assert.deepEqual(seen[0]!.tools, RESEARCH_WEB_TOOLS);
    assert.deepEqual([...seen[0]!.tools!].sort(), ["WebFetch", "WebSearch"]);
    assert.equal(seen[0]!.maxTurns, RESEARCH_MAX_TURNS);
    assert.deepEqual(seen[0]!.domains, ["docs.python.org"]);
    // The prompt half moves with the tools: a granted finding's source is the URL that
    // was actually fetched, and the allowlist is named so the model can plan around it.
    assert.match(seen[0]!.systemPrompt, /docs\.python\.org/);
    assert.match(seen[0]!.systemPrompt, /sourceKind: "web"/);
  });

  // The grant is read-only egress and nothing else — no `Read`, `Glob` or `Grep`, or the
  // repository enters the call and §4's context discipline is gone.
  test("the grant never includes a filesystem tool", () => {
    for (const tool of ["Read", "Glob", "Grep", "Write", "Bash"]) {
      assert.equal(RESEARCH_WEB_TOOLS.includes(tool), false);
    }
  });

  // Denied hosts have to reach `prepareMission`, which raises them as one advisory
  // question. Carried on the result rather than through the schema: no model wrote them.
  test("a denied host comes back on the result rather than failing the call", async () => {
    const calls = createAgentCalls({
      config,
      runQuery: async () => ({
        text: JSON.stringify({ brief: "b", findings: [], confidence: "high" }),
        spend,
        deniedHosts: ["evil.example"],
      }),
    });

    const result = await calls.research({
      question: "q",
      sources: ["web"],
      depth: "deep",
      web: { domains: [] },
    });

    assert.deepEqual(result.deniedHosts, ["evil.example"]);
    assert.equal(result.brief, "b");
  });
});

// The permission callback runs below the fixture seam, so the decision it makes is
// pulled out here: a fetch allowed because the URL merely mentions a granted host, or a
// third tool arriving and being waved through, is egress nobody approved.
describe("webFetchDecision", () => {
  const granted = ["docs.python.org"];

  test("allows a granted fetch and denies one outside the list, naming the host", () => {
    assert.equal(webFetchDecision("WebFetch", { url: "https://docs.python.org/3/" }, granted).allow, true);

    const denied = webFetchDecision("WebFetch", { url: "https://evil.example/x" }, granted);
    assert.equal(denied.allow, false);
    assert.equal(denied.allow === false && denied.host, "evil.example");
    assert.match(denied.allow === false ? denied.message : "", /docs\.python\.org/);
  });

  // Stated plainly because it cannot be fixed: results come from a backend, not from a
  // host the envelope could name, so there is nothing here to check.
  test("search is allowed under the grant because it has no host to check", () => {
    assert.equal(webFetchDecision("WebSearch", { query: "anything" }, []).allow, true);
  });

  test("any other tool is denied, since the grant is two tools", () => {
    assert.equal(webFetchDecision("Read", { file_path: "/etc/passwd" }, granted).allow, false);
    assert.equal(webFetchDecision("Bash", { command: "curl x" }, granted).allow, false);
  });

  test("a fetch with no usable url is denied rather than allowed by default", () => {
    assert.equal(webFetchDecision("WebFetch", {}, granted).allow, false);
    assert.equal(webFetchDecision("WebFetch", { url: 42 }, granted).allow, false);
  });
});
