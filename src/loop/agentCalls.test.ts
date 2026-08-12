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
} from "./agentCalls.js";
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

    test("synthesize returns an agent spec", async () => {
      const { run } = transport([JSON.stringify(anAgentSpec({ role: "invoice-reconciler" }))]);
      const calls = createAgentCalls({ config, runQuery: run });

      const spec = await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: [],
        transports: ["cli"],
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
      });

      assert.match(seen.prompts[0]!, /Read/);
      assert.match(seen.prompts[0]!, /Glob/);
      assert.match(seen.systemPrompts[0]!, /toolCatalogue/);
      assert.match(seen.systemPrompts[0]!, /owns/);
      // The schema is rendered into the prompt, so `owns` cannot be described in prose
      // and absent from the shape the boundary will reject.
      assert.match(seen.systemPrompts[0]!, /"owns"/);
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
