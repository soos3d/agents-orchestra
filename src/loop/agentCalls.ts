// The decision points, against a real model (§3). Eight since PLAN-NEXT 5 added
// `architect` and `critique`.
//
// **This is the one file the fixture harness cannot cover**, because it is the thing
// the harness substitutes for. That is not a gap to close — everything above the
// `Calls` interface stays testable for free, which is the point — but it does mean a
// green suite says nothing about the arguments below. Six defects hid here behind 331
// passing tests until the first real mission ran: an auto-approve list mistaken for a
// restriction, a turn cap that fired on legitimate answers, prompts that asked for
// JSON without saying which, a transport that was never built, and a judge that could
// not open the artifacts it was grading. So: what the model *receives* belongs in a
// pure function (`queryOptions`, `withSchema`, `JUDGE_TOOLS`) where the next
// regression is catchable — and still wants one real `--plan-only` run before you
// believe a change to it.
//
// Three rules shape every call here, and all three come from §3:
//
//   Fresh context every time. Nothing carries over implicitly. A decision point is a
//   one-shot question over a prompt built by folding the log, not a turn in a
//   conversation — which is what stops round 15 paying for round 1.
//
//   Structured return, validated at the boundary. Zod, one reformat attempt, then
//   the call fails. The same allowance a worker report gets, for the same reason: a
//   model that cannot produce its return type has told us nothing.
//
//   No tools, with one exception the spec itself makes. A decision point reasons over
//   what the prompt carries and nothing else; letting it read files would quietly
//   reintroduce the context growth the whole loop architecture exists to avoid. The
//   exception is `judge`, which §3 requires to read artifacts rather than the
//   worker's report — read-only, and asserted against every other call getting none.
//   See `JUDGE_TOOLS`.
import path from "node:path";
// Type-only, so it is erased at compile time and the lazy `import()` in `runViaAgentSdk`
// stays the only thing that loads the SDK — a `--plan-only` run against a supplied
// `Calls` must still never look for credentials.
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type DiscoveredConfig } from "../config/discover.js";
import { evidenceSchema } from "../domain/artifacts.js";
import { allowedFetchHost, hostOf } from "../domain/envelope.js";
import { tokensFrom, type Spend } from "../domain/budget.js";
import {
  criterionSchema,
  criterionSchemaWithoutScanner,
  findingSchema,
  guessSchema,
  plannedTaskSchema,
  progressLedgerSchema,
} from "../domain/ledger.js";
import { agentSpecSchema } from "../domain/task.js";
import { extractJsonObject, renderSchema } from "../runtime/json.js";
import {
  type ArchitectResult,
  type Calls,
  type CritiqueResult,
  type IntakeResult,
  type JudgeResult,
  type PlanResult,
  type ResearchResult,
} from "./calls.js";
import { PANEL_LENSES, type PanelLens } from "./criteria.js";
import { judgeLens } from "./prompts.js";

/**
 * One model call: a prompt in, text and what it cost out. Injected so the JSON
 * boundary — the part that actually breaks — is testable without a model.
 */
export type RunQuery = (input: {
  systemPrompt: string;
  prompt: string;
  model: string;
  /** Empty for every call but `judge` — see `JUDGE_TOOLS`. */
  tools?: string[];
  maxTurns?: number;
  /** Absolute directories the call may read outside the process cwd — `judge` only. */
  directories?: readonly string[];
  /** The hosts a granted `research` call may fetch (PLAN-NEXT 11.3). Absent for every
   *  other call and for every mission that granted no egress; present-and-empty is a
   *  grant that named no host, where search works and every fetch is denied. */
  domains?: readonly string[];
  /** The mission's repository. Absent only when nothing was discovered (P3). */
  cwd?: string;
  /**
   * The type this answer is validated against, for a transport that can *constrain* the
   * answer rather than only ask for it (PLAN-NEXT 4.2).
   *
   * The Agent SDK path ignores it — `withSchema` has already rendered the same schema
   * into the system prompt, which is the only lever that path has. An OpenAI-compatible
   * provider takes a `response_format`, so `loop/providerCalls.ts` reads it here rather
   * than re-deriving a second copy from a second source of truth.
   */
  schema?: z.ZodType<unknown>;
  signal?: AbortSignal;
}) => Promise<{
  text: string;
  spend: Spend;
  /** What the transport says actually answered, where it says so. `modelByPhase` is
   *  priced off this and never off the model that was *asked for* — the distinction has
   *  already cost a 5× error once (`.claude/notes/spend.md`). */
  ranOn?: string;
  /** Hosts this call asked to fetch and was refused (PLAN-NEXT 11.3). Absent from every
   *  transport that grants no tools, which is every one but the Agent SDK. */
  deniedHosts?: readonly string[];
}>;

export interface AgentCallsDeps {
  // `repoRoot` and `cwd` are here because P3 was a defect a type was hiding: this was
  // `Pick<…, "orchestratorModel">` while `createAgentCalls` was handed the whole
  // config, so every call site read correctly and the mission's own repository was
  // dropped at the boundary. A decision point then ran wherever the terminal was.
  config: Pick<DiscoveredConfig, "orchestratorModel" | "repoRoot" | "cwd">;
  /** Where the measured portion of the mission's spend is recorded (§9.5). `ranOn` is
   *  what the transport says answered, absent when it does not say. */
  onSpend?(call: keyof Calls, spend: Spend, ranOn?: string): void;
  runQuery?: RunQuery;
  signal?: AbortSignal;
}

/**
 * `progress` is a small structured judgment over a short input, called more often
 * than anything else in the loop, so it defaults to a cheaper model than `plan` or
 * `judge` (§3). Everything else uses the mission's orchestrator model.
 */
export const PROGRESS_MODEL = "sonnet";

/** See `queryOptions` — a backstop, not a budget. */
export const MAX_TURNS = 6;

/**
 * The one place §3's "no tools" rule bends, and the spec is what bends it: a judge
 * reads artifacts rather than the worker's report, because a summary written by the
 * thing being graded is not evidence. `JudgeInput` hands over `artifactPaths`, and
 * with an empty tool set there was no way to open them — against a real model the
 * judge said so and failed the criterion, which was the correct call and an
 * impossible position to put it in.
 *
 * Read-only, deliberately. A judge that can write is a judge that can make the
 * artifact match the rubric, which is the same circularity §3 removed the worker's
 * report to avoid. Nothing here mutates anything.
 */
export const JUDGE_TOOLS = ["Read", "Glob", "Grep"];

/** Reading N artifacts is a loop; answering from the prompt is not. */
export const JUDGE_MAX_TURNS = 20;

/**
 * The second place §3's "no tools" rule bends, and it is narrower than `judge`'s
 * (PLAN-NEXT 11.3).
 *
 * The ledger already demands what the call could not produce: a `Finding` carries a
 * `source` and `"web"` is in `sourceKind`, so every web-shaped finding a closed mission
 * returns is a recollection wearing a citation. The grant is read-only egress and
 * nothing else — no `Read`, `Glob` or `Grep`, so none of the repository enters the call
 * and the context discipline §4 exists for is untouched.
 *
 * The names are `net.read`'s in `workers/toolCatalogue.ts`, which is where a tool name
 * is written down once.
 */
export const RESEARCH_WEB_TOOLS = ["WebSearch", "WebFetch"];

/**
 * The turn cap for a granted research call, and the reason it is not `MAX_TURNS`.
 *
 * Six is a backstop sized for a call that cannot loop: with `tools: []` there is nothing
 * to interrupt. Searching and then fetching what the search returned is a loop, so the
 * old backstop would fire on a legitimate answer — `error_max_turns`, no result, and the
 * mission pays for a research call that returned nothing. Same number as `JUDGE_MAX_TURNS`
 * and for the same shape of work: N reads before one answer.
 */
export const RESEARCH_MAX_TURNS = 20;

/**
 * Whether one tool call from a granted research call is inside the mission's allowlist.
 *
 * Pure, exported and tested because the callback that uses it lives in
 * `runViaAgentSdk` — below the fixture seam, in the file six defects hid in — and a
 * permission decision nothing can assert is the optional-`Deps` trap with a security
 * boundary attached.
 *
 * `WebSearch` is not decidable here and saying so is the honest answer: its results come
 * from a backend rather than from a host the envelope could name, so there is no URL to
 * check and it is allowed whenever the grant exists. `WebFetch` is the enforced half.
 * Anything else is denied — the grant is two tools, and a third arriving means the
 * option list and this function disagree.
 */
export function webFetchDecision(
  toolName: string,
  input: unknown,
  domains: readonly string[],
): { allow: true } | { allow: false; host: string; message: string } {
  if (toolName === "WebSearch") return { allow: true };
  if (toolName !== "WebFetch") {
    return { allow: false, host: "", message: `${toolName} is not granted to this call.` };
  }

  const url = (input as { url?: unknown }).url;
  const target = typeof url === "string" ? url : "";
  if (allowedFetchHost(target, domains)) return { allow: true };

  const host = hostOf(target) ?? target;
  return {
    allow: false,
    host,
    message:
      `This mission's envelope does not grant ${host || "that host"}. ` +
      `Use a source it does grant${domains.length > 0 ? ` (${domains.join(", ")})` : ""}, ` +
      `or return the claim as a guess rather than a finding.`,
  };
}

/**
 * The directories a judge is allowed to read, derived from the artifacts it was handed.
 *
 * Defect 40, and the third layer of one wound: defect 22 gave the judge tools, 33 and 39
 * gave it paths that resolve, and it still could not open them — a task's artifacts live
 * in its worktree, which is not under the orchestrator's cwd, and the Agent SDK refuses
 * a `Read` outside it. The judge reported exactly that and returned `met: false`, which
 * is the only honest answer available to it and fails work that was done correctly.
 *
 * Derived rather than configured, and that is the security argument as well as the
 * convenience one: the grant is exactly the directories of the files this criterion is
 * about, so a judge cannot wander. Relative paths are dropped — `additionalDirectories`
 * wants absolute ones, and by the time a path reaches here `artifactPaths` has already
 * resolved everything it could against the check's cwd.
 */
export function readableDirectories(artifactPaths: readonly string[]): string[] {
  const dirs = artifactPaths
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.dirname(candidate));
  return [...new Set(dirs)];
}

export function createAgentCalls(deps: AgentCallsDeps): Calls {
  const run = deps.runQuery ?? runViaAgentSdk;
  const model = deps.config.orchestratorModel;
  // Where the mission lives, which is not where the orchestrator process was started
  // (P3). `repoRoot` when there is a repo, the discovered directory when there is not
  // — `discoverConfig` supports both, and a decision point briefing on the wrong tree
  // is the same class of failure as a judge reading `main` pre-merge (defect 33).
  const cwd = deps.config.repoRoot ?? deps.config.cwd;

  // What a granted `research` call was refused, collected across its attempts. Local to
  // this factory rather than returned through `ask`, because only `research` is ever
  // granted a fetch and only `research` reads the list — threading a second return value
  // through every call to carry one call's fact is the shape `onSpend` already rejected.
  const deniedHosts = new Set<string>();

  const ask = async <T>(
    call: keyof Calls,
    spec: {
      systemPrompt: string;
      prompt: string;
      schema: z.ZodType<T>;
      model?: string;
      tools?: string[];
      maxTurns?: number;
      directories?: readonly string[];
      domains?: readonly string[];
    },
  ): Promise<T> => {
    const systemPrompt = withSchema(spec.systemPrompt, spec.schema);

    const attempt = async (prompt: string) => {
      const result = await run({
        systemPrompt,
        prompt,
        model: spec.model ?? model,
        tools: spec.tools ?? [],
        maxTurns: spec.maxTurns ?? MAX_TURNS,
        schema: spec.schema,
        ...(spec.directories ? { directories: spec.directories } : {}),
        ...(spec.domains ? { domains: spec.domains } : {}),
        ...(cwd ? { cwd } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      deps.onSpend?.(call, result.spend, result.ranOn);
      for (const host of result.deniedHosts ?? []) deniedHosts.add(host);
      // The raw text rides along so a rejection can quote it (P4). Discarded on the
      // happy path by the caller, which only reads `value`.
      return { ...validate(result.text, spec.schema), raw: result.text };
    };

    const first = await attempt(spec.prompt);
    if ("value" in first) return first.value;

    // One reformat attempt. A second would let a model that cannot follow the
    // schema spend the mission's budget on retries.
    const second = await attempt(
      `${spec.prompt}\n\n## Your last answer was rejected\n\n${first.problem}\n\n` +
        `Return the same information as a single JSON object matching the schema, and nothing else.`,
    );
    if ("value" in second) return second.value;

    throw new CallFormatError(call, second.problem, second.raw);
  };

  return {
    research: async (input) => {
      const result = await ask("research", {
        systemPrompt: researchSystemPrompt(input.web?.domains),
        prompt: describe("Research request", input),
        schema: researchSchema,
        // Tools and a real turn cap only where egress was granted (PLAN-NEXT 11.3), so
        // an ungranted mission's call is the one that has always run.
        ...(input.web
          ? {
              tools: RESEARCH_WEB_TOOLS,
              maxTurns: RESEARCH_MAX_TURNS,
              domains: input.web.domains,
            }
          : {}),
      });
      // Absent rather than empty when nothing was refused, so `prepareMission` raises a
      // question on a fact rather than on the length of a list.
      return deniedHosts.size === 0 ? result : { ...result, deniedHosts: [...deniedHosts] };
    },

    architect: (input) =>
      ask("architect", {
        systemPrompt: architectSystemPrompt(input.scanners),
        prompt: describe("What research found", input),
        schema: architectSchema,
      }),

    intake: (input) =>
      ask("intake", {
        systemPrompt: INTAKE_PROMPT,
        prompt: describe("What the scan found", input),
        schema: intakeSchema,
      }),

    plan: (input) =>
      ask("plan", {
        systemPrompt: PLAN_PROMPT,
        prompt: describe("Planning request", input),
        schema: planSchema,
      }),

    critique: (input) =>
      ask("critique", {
        systemPrompt: CRITIQUE_PROMPT,
        prompt: describe("Plan to attack", input),
        schema: critiqueSchema,
      }),

    synthesize: (input) =>
      ask("synthesize", {
        systemPrompt: SYNTHESIZE_PROMPT,
        prompt: describe("Task to staff", input),
        schema: agentSpecSchema,
      }),

    progress: (input) =>
      ask("progress", {
        systemPrompt: PROGRESS_PROMPT,
        prompt: describe("This round", input),
        schema: progressLedgerSchema,
        model: PROGRESS_MODEL,
      }),

    judge: (input) =>
      ask("judge", {
        systemPrompt: judgeSystemPrompt(input.lens),
        prompt: describe("Criterion to judge", input),
        schema: judgeSchema,
        tools: JUDGE_TOOLS,
        maxTurns: JUDGE_MAX_TURNS,
        directories: readableDirectories(input.artifactPaths),
      }),
  };
}

/**
 * The call's return type, rendered into its own system prompt.
 *
 * Every prompt used to end with "Answer with a single JSON object" without saying
 * which one, which left the model guessing field names it could not have guessed —
 * a real `research` call came back with `guesses` as an array of strings, because
 * nothing had told it a `Guess` carries an id, a basis, and an addedRound. The one
 * reformat attempt then spends a second call teaching what the first should have.
 *
 * Derived from the zod schema rather than written by hand, so the two cannot drift:
 * the prompt is wrong the moment the schema changes, and that is a compile-time file
 * away rather than a silent runtime rejection. `io: "input"` because the model is
 * writing the parser's input, and `unrepresentable: "any"` because `criteria` is
 * deliberately `unknown[]` (§4) and must render rather than throw.
 */
function withSchema(systemPrompt: string, schema: z.ZodType<unknown>): string {
  return (
    `${systemPrompt}\n\n## The exact shape of your answer\n\n${renderSchema(schema)}\n\n` +
    `Every required field must be present. Return that object and nothing else.`
  );
}

/**
 * The last thing a decision-point reply is worth: a bounded tail of it (P4).
 *
 * Deliberately not `tail` from `workers/transport.ts`. That constant is sized for a
 * worker's final message and importing it would tie the loop's error text to the
 * worker layer's reformat budget — two numbers that answer different questions and
 * would then have to move together. 4_000 characters is more than any decision-point
 * reply needs to be recognisable.
 */
const RAW_REPLY_LIMIT = 4_000;

const quotedTail = (raw: string): string =>
  raw.length <= RAW_REPLY_LIMIT ? raw : `…${raw.slice(-RAW_REPLY_LIMIT)}`;

export class CallFormatError extends Error {
  readonly call: keyof Calls;
  /** What the model actually said, bounded. Empty only if it said nothing. */
  readonly raw: string;

  // `problem` alone says the answer did not parse and never says what the answer was,
  // so the one thing that would identify the cause — a refusal, a wrapped fence, a
  // truncation — was thrown away at the point of failure (P4). `WorkerReportError`
  // has carried its raw text since Phase 1a for exactly this reason.
  constructor(call: keyof Calls, problem: string, raw = "") {
    super(
      `The '${call}' decision point did not return its schema after one reformat ` +
        `attempt: ${problem}. The loop cannot continue on an unparseable answer.` +
        (raw ? `\n\nWhat it said:\n${quotedTail(raw)}` : ""),
    );
    this.name = "CallFormatError";
    this.call = call;
    this.raw = raw;
  }
}

function validate<T>(raw: string, schema: z.ZodType<T>): { value: T } | { problem: string } {
  const json = extractJsonObject(raw);
  if (json === undefined) return { problem: "no JSON object was found in the response" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { problem: `the JSON object does not parse: ${(err as Error).message}` };
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { value: result.data };

  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { problem: `it does not match the schema — ${issues}` };
}

/** The whole input, verbatim. A decision point's prompt is a pure function of folded
 *  state (§3), so hand-summarizing it here would put a second, undeclared reducer in
 *  the loop. */
const describe = (label: string, input: unknown): string =>
  `## ${label}\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;

// ── return schemas ─────────────────────────────────────────────────────
//
// `criteria` on research stays unknown: it is model output, and writeOutcomeSpec is
// the boundary that rejects a criterion with no check. Typing it here would make the
// rejectable case unrepresentable.
const researchSchema: z.ZodType<ResearchResult> = z.object({
  brief: z.string(),
  findings: z.array(findingSchema),
  confidence: z.enum(["high", "medium", "low"]),
  criteria: z.array(z.unknown()).optional(),
  guesses: z.array(guessSchema).optional(),
  outOfScope: z.array(z.string()).optional(),
});

// `criteria` is open for `researchSchema`'s reason and the same boundary rejects it:
// the outcome spec moved here from research (PLAN-NEXT 5.1) and `writeOutcomeSpec` did
// not move with it. `designNote` is required and non-empty — the call exists to produce
// it, and an architect that returns a spec and no design has answered half the question
// while the mission carries on as though it answered all of it.
const architectSchema: z.ZodType<ArchitectResult> = z.object({
  // Required and non-empty, because this call *is* the criteria author and the very next
  // step refuses an answer without them. Optional here cost two live missions: the model
  // was shown a shape saying `criteria` could be left out, left it out, and
  // `writeOutcomeSpec` then rejected "(empty)" twice and ended the mission with a design
  // note and no contract. Sent back inside `ask` for one cheap reformat rather than
  // costing an architect round trip at the prepare layer — the same trade `designNote`'s
  // `min(1)` already makes, one field along. Still `unknown[]`: an uncheckable criterion
  // has to *reach* `writeOutcomeSpec` to be refused by it.
  criteria: z.array(z.unknown()).min(1),
  designNote: z.string().min(1),
  // Names, and the schema is where "names only" is enforced rather than hoped for. A
  // POSIX variable name, not merely "no `=` in it": a model that answers
  // `STRIPE_KEY=sk_live_…` fails the boundary, and so does one that answers the key on
  // its own — either would write a live credential into `secret_required` and into the
  // question raised beside it, where nothing can ever scrub it.
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  guesses: z.array(guessSchema).optional(),
  outOfScope: z.array(z.string()).optional(),
});

// No `min(1)` on `objections`: an empty list is the answer a good plan gets, and a
// schema that refused it would buy a reformat call to be told the same thing.
const critiqueSchema: z.ZodType<CritiqueResult> = z.object({
  objections: z.array(
    z.object({
      kind: z.string().min(1),
      detail: z.string().min(1),
      taskId: z.string().optional(),
    }),
  ),
});

// No cap here on purpose. §2b's limit of three is enforced in `loop/intake.ts`, where
// a fourth question is dropped rather than rejected — a schema violation would cost a
// reformat call and end with the same three questions.
const intakeSchema: z.ZodType<IntakeResult> = z.object({
  questions: z.array(
    z.object({
      id: z.string().min(1),
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
    }),
  ),
});

const planSchema: z.ZodType<PlanResult> = z.object({
  tasks: z.array(plannedTaskSchema),
  criteria: z.array(criterionSchema).optional(),
});

const judgeSchema: z.ZodType<JudgeResult> = z.object({
  met: z.boolean(),
  evidence: evidenceSchema,
});

// ── system prompts ─────────────────────────────────────────────────────

const SHAPE = "Answer with a single JSON object and no other text.";

/**
 * What the two tool-less calls have to be told about the repository map (PLAN-NEXT 8.1).
 *
 * One constant for both, `CHECK_AUTHORING_BASE`'s rule: research and the architect are
 * shown the same string from the same cache, and two descriptions of one field drift the
 * first time either is corrected. Unconditional rather than a function of whether a map
 * arrived — it is three sentences, and `repoKb` is absent from the input when there is
 * none, which is the fact the first clause turns on.
 *
 * The staleness sentence is the load-bearing one. The map is built at a commit and cached
 * until HEAD moves, so a file written this morning and not committed is not in it — and a
 * design that treats the map as a listing tells a worker a directory is empty when the
 * worker is about to find work in it.
 */
const REPO_MAP = `If the input carries \`repoKb\`, it is a map of one repository at one
commit: every tracked directory with the number of files in it, and the opening of its
top-level documents. You have no tools and cannot open a file, so that map is the whole of
what you can see of the tree — name paths that appear in it, and where you need a file it
does not list, say what should be created rather than describing it as already there.
It is a snapshot and not a listing: uncommitted work is absent from it, and a file count is
not a claim about what the files contain.`;

/**
 * What a call that authors a criterion has to be told about `command` checks.
 *
 * One constant rather than a paragraph per prompt, because the outcome spec is now
 * written by two different calls — `architect` on an ordinary mission, `research` on a
 * quick one where the scan is the only pass — and the rule they are taught is a fact
 * about `runtime/command.ts`, not about either call. Defect 44 is what it is for: a
 * check carrying `r'-?\\d+\\.?\\d*'` ran with the backslashes eaten, matched nothing, and
 * failed three criteria while quoting the correct output of a correct script.
 */
const CHECK_AUTHORING_BASE = `A \`command\` check runs as one program with arguments, not
through a shell: no pipes, no \`&&\`, no \`$()\`, no redirects, no glob expansion. A
check that needs any of those is refused when it fires and the criterion can never be
met, however good the work was. \`node --test test/foo.test.js\` is a check; a grep
chained to a test run is two checks — write two criteria, or fold the logic into a judge
rubric.

Nothing in the string is expanded either. A quoted argument reaches the program
exactly as written, so a \`\\n\` inside one stays a backslash followed by an \`n\`
rather than becoming a line break — a \`-c\` program written with \`\\n\` between its
statements is a syntax error, not a multi-line script. Keep a one-liner genuinely one
line, separating statements with \`;\`, or check something a task has left on disk.

A check is graded on its **exit code** and nothing ever reads its output, so it has to
*exit non-zero* when it fails: \`process.exit(ok ? 0 : 1)\`, an assertion, or a test
runner. A one-liner that prints \`false\` and exits 0 is recorded as met however the work
turned out — a criterion that cannot fail is not a gate, and the spec gate refuses that
shape at authoring.`;

/**
 * The check-authoring rules, plus the specialist gate **only when one was granted**
 * (PLAN-NEXT 6.3).
 *
 * A function rather than a constant, and a real run is why. The scanner paragraph was
 * first written into the constant, so every criteria-authoring call carried it whether or
 * not the mission could use it — and the architect on `Qwen/Qwen3-30B-A3B-Instruct-2507`
 * then returned a design note and **no criteria at all**, twice, on a goal it had handled
 * before. `writeOutcomeSpec` refused `(empty)` and the mission died in the gate. Deleting
 * the paragraph restored three criteria and a plan on the same goal and the same card.
 *
 * So this is not only "nothing is offered that was not verified" applied to a prompt: it
 * is a measurement. A mission that granted no scanner gets the byte-identical text it got
 * before 6.3 existed, which is the only version any model has been observed to answer
 * correctly. The offer is short, positive and concrete for the same reason — the
 * paragraph that broke it was long and mostly about what not to do.
 */
export function checkAuthoring(scanners: readonly string[] = []): string {
  if (scanners.length === 0) return CHECK_AUTHORING_BASE;
  return (
    `${CHECK_AUTHORING_BASE}\n\n` +
    `This mission may also use a \`scanner\` check: ` +
    `\`{"kind":"scanner","scanner":"${scanners[0]}","minSeverity":"HIGH"}\`. It runs ` +
    `${scanners.join(" or ")} over the files this mission changes and fails the criterion ` +
    `on findings at \`minSeverity\` or above — one of \`CRITICAL\`, \`HIGH\`, ` +
    `\`HIGH_BUG\`, \`MEDIUM\`, \`BUG\`, \`LOW\`. Use it for a security criterion and ` +
    `nothing else; it cannot tell you whether a feature works.`
  );
}

/**
 * What a granted research call is told about its egress, and nothing when it has none
 * (PLAN-NEXT 11.3) — `checkAuthoring`'s shape and its reason.
 *
 * An ungranted mission's prompt is byte-identical to the one it had before this stage,
 * which is the only version any model has been measured on. The paragraph is short and
 * about what to *do* with the tools, because the scanner offer that broke Qwen was long
 * and mostly about what not to do.
 */
export function researchAuthoring(domains: readonly string[] = []): string {
  return (
    `You have \`WebSearch\` and \`WebFetch\` for this call, and no other tools — you ` +
    `still cannot open a file in the repository. Use them: a finding with ` +
    `\`sourceKind: "web"\` must carry the URL you actually fetched as its \`source\`, ` +
    `and a claim you did not fetch is a guess whatever you remember about it.\n\n` +
    (domains.length > 0
      ? `\`WebFetch\` is held to this mission's allowlist: ${domains.join(", ")}. A fetch ` +
        `outside it is refused and the refusal names the host — take the claim to a ` +
        `granted source or return it as a guess. `
      : `This mission granted no hosts, so every \`WebFetch\` is refused and search ` +
        `results are all you have. Return what you cannot fetch as a guess. `) +
    `Search itself is not constrained by that list: results come from a backend rather ` +
    `than a host, so what you search is up to you and what you fetch is not. A search ` +
    `result is not a fetch — put a claim you took from a snippet in \`guesses\`, with the ` +
    `search and the URL it pointed at as its \`basis\`. A \`"web"\` finding sourced to a ` +
    `host outside the allowlist, or to anything that is not a URL, is dropped before the ` +
    `architect reads it, because this mission cannot have fetched it.`
  );
}

/**
 * The research call's system prompt, with the egress paragraph only where a human
 * granted egress — `judgeSystemPrompt`'s shape, so the lens lands before `SHAPE` rather
 * than after it.
 */
export function researchSystemPrompt(domains?: readonly string[]): string {
  const granted = domains === undefined ? [] : [researchAuthoring(domains)];
  return [RESEARCH_BODY, ...granted, SHAPE].join("\n\n");
}

const RESEARCH_BODY = `You research a mission before it is planned.

An architect reads what you return and writes the outcome spec from it, so findings are
the deliverable here — **with one exception, and \`solePass\` is how you know you are it**
(see below). Leave \`criteria\` out otherwise: a spec written twice by two calls is two
contracts, and the second one wins for no reason anybody chose.

Return findings with a real source each — a URL, a file path, or a memory path. A
claim you cannot source is a guess, so put it in \`guesses\` rather than \`findings\`.

Anything under \`known\` was established by a previous mission and is already in the
ledger. Do not re-verify it and do not return it as a finding; spend the research
effort on what it leaves open. Facts that needed re-checking are not in that list —
they were handed back as guesses instead.

Anything under \`priorCriteria\` is what this same job was judged against on a previous
run. It is a starting skeleton to converge on, not a contract to copy: re-validate every
statement against what you find in the environment now, drop what no longer applies, and
add what this run needs. A criterion carried over unexamined is last month's answer to
this month's question.

Every criterion needs a \`check\` that will actually produce an answer: a command to
run, or a rubric for a judge to grade artifacts against. A criterion nothing can
evaluate means the mission can never legitimately report success, and it is rejected.

A \`depth\` of \`scan\` is normally a first cheap look, and the deep pass that follows is
what writes the outcome spec. **\`solePass: true\` means there is no deep pass.** A human
looked at this job and said it is small, so this call is the whole of the mission's
research: return the criteria, with a real check on each, exactly as a deep pass would.
Returning findings and no criteria there does not save the mission anything — it fails
the gate and buys the deep call you were skipping.

If the input carries \`rejected\`, this is your one retry and that field is the gate's
verdict on the criteria you just returned, quoted back. Fix what it names rather than
starting over: keep every criterion it did not object to, and rewrite the ones it did
so they carry a check that will actually run. Returning the same shape again ends the
mission.

Each entry in \`criteria\` has this shape. It is spelled out here because the return
schema below types \`criteria\` as an open array on purpose — that is what lets an
uncheckable criterion reach the gate that rejects it, rather than being silently
dropped at the boundary. Getting the shape right is still on you:

${renderSchema(criterionSchemaWithoutScanner)}

Note the \`check\` union: \`command\` needs a \`command\` string, \`judge\` needs a
\`rubric\`, and \`none\` needs a \`reason\` justifying why nothing can check it.

${checkAuthoring()}

${REPO_MAP}`;

/**
 * The architect's system prompt, carrying the scanner offer only when the mission has
 * one (PLAN-NEXT 6.3) — `judgeSystemPrompt`'s shape, and `checkAuthoring`'s reason.
 *
 * A function rather than a constant because the offer is a per-mission fact and this is
 * the only call that ever receives one: the architect writes the outcome spec on every
 * mission that can afford a scan.
 */
const architectSystemPrompt = (scanners: readonly string[] = []) =>
  `You turn what research found into a design and into the
outcome spec this mission will be judged against.

You are given a brief, the findings behind it, whatever the human answered at intake
(\`known\`), and the goal. You write two things and they are not the same thing.

\`designNote\` is markdown, and it is written for the engineers who will do the work —
each of them sees one task and never the mission around it, so the note is the only
place the shape of the whole is written down. Say what the pieces are, where they live,
what talks to what, and which decisions are already made so nobody re-makes them
differently in two worktrees. Name concrete files and concrete interfaces. Where an
external dependency is involved, say which one and what it is behind. Keep it to what a
person would need to start; this is a design note, not a specification, and nobody is
paying you by the paragraph.

**Design against mocks first.** Every external dependency — an HTTP API, a payment
provider, a database this environment does not have — gets an interface and a fake
implementation of it in the design, and the work that talks to the real thing is the
*last* task in the plan. The engineers run in parallel worktrees with no credentials
and no network, so a design whose first task calls a live API is a design where nothing
can be finished or checked. Say in the note which interface stands in for what, and
write at least one criterion the mocked build satisfies on its own — "the payment
client runs green against the in-repo fake" is checkable today; "charges a real card"
is not.

List in \`envVars\` the **names** of the environment variables the real integration
would need — \`STRIPE_KEY\`, not the key. Never a value: what you return is written to
an event log a human pastes into bug reports. Naming one does not grant it and does not
stop the mission; it raises a question for the human and the plan proceeds against the
mocks either way.

Write it with real line breaks — inside a JSON string those are \`\\n\` escapes, two
characters that a parser turns back into newlines. A note whose headings and bullets are
separated by spaces instead arrives on disk as one long line, and the worker who opens it
is reading a wall of text rather than a document. (Observed on a real run, 2026-08-16.)

\`criteria\` is the contract. Every criterion needs a \`check\` that will actually
produce an answer: a command to run, or a rubric for a judge to grade artifacts against.
A criterion nothing can evaluate means the mission can never legitimately report
success, and it is rejected.

Cover the goal, not the design. A criterion about an internal decision you just made is
a criterion that fails when the work is done a better way; a criterion about what the
human asked for survives the design changing under it.

Anything under \`priorCriteria\` is what this job was judged against on a previous run:
a starting skeleton to converge on, never a contract to copy. Re-validate each statement
against what the findings say about the environment now.

If the input carries \`rejected\`, this is your one retry and that field is the gate's
verdict on the criteria you just returned, quoted back. Fix what it names rather than
starting over: keep every criterion it did not object to, rewrite the ones it did, and
return the design note again — it is not stored between attempts.

Each entry in \`criteria\` has this shape. It is spelled out here because the return
schema below types \`criteria\` as an open array on purpose — that is what lets an
uncheckable criterion reach the gate that rejects it:

${renderSchema(scanners.length === 0 ? criterionSchemaWithoutScanner : criterionSchema)}

Note the \`check\` union: \`command\` needs a \`command\` string, \`judge\` needs a
\`rubric\`, and \`none\` needs a \`reason\` justifying why nothing can check it.

${checkAuthoring(scanners)}

${REPO_MAP}

${SHAPE}`;

const CRITIQUE_PROMPT = `You attack a plan before anything runs on it. You are not
asked to improve it and you do not return one — you return what is wrong with this one.

The tasks run in *parallel git worktrees*, each with an agent that sees its own goal and
nothing else, and each merging back when it passes. That is what makes these four the
objections worth raising:

- **A missing dependency.** Task B needs what task A produces and does not say so in
  \`dependsOn\`, so the two start together and B works against a tree that has not got
  A's work in it yet.
- **A collision.** Two tasks will write the same file. They hold separate leases in
  separate worktrees, so this is not caught until one of them fails at merge having done
  its work.
- **A criterion no judge can check.** A criterion whose check grades a summary, a final
  message, or "the output" cannot be evaluated: a judge is given files on disk and
  nothing else. The task then fails however well it was done.
- **A criterion nothing in the plan satisfies**, or a task that satisfies nothing. Both
  are ways for a mission to finish every task and still be unable to report success.

**Only when the input carries a \`design\`**, there is a fifth: **the plan does not build
what was designed.** The design is what the work was supposed to be, written before the
breakdown existed — a task that implements something else, or a piece of the design no
task carries, is an objection the planner can act on. Say which part of the design and
which task, or which part nothing covers.

Ground each objection in a task id where it is about one task, and say concretely what
goes wrong rather than what would be nicer — "t2 edits src/api.ts, which t1 also owns"
is an objection; "the plan could be cleaner" is not.

**Say nothing when there is nothing to say.** An empty \`objections\` list is the answer
a sound plan gets, and it is the answer you should give most of the time. Every objection
costs the mission a full replan, so a stylistic complaint is not free — it buys a second
plan that is no better and one round further from the work.

${SHAPE}`;

const INTAKE_PROMPT = `You ask a human the few questions that would change how this
mission is planned, having already looked at their environment.

You get at most three, and fewer is better. Anything you do not ask becomes a labelled
guess the human reviews at sign-off, which is a cheaper place to catch it than a
question they have to stop and answer.

Ask only what is *load-bearing* — where two readings of the brief lead to different
work — and only what the findings show is genuinely ambiguous. Two test commands in
one repo is a real question. "What does done look like?" is not: they answered that by
writing the brief, and asking it back reads as not having looked.

Ground every question in something the findings actually show, and name it. Offer
\`options\` when the answer is a choice between things you found.

Ask nothing at all if nothing is ambiguous. An empty list is a good answer.

${SHAPE}`;

const PLAN_PROMPT = `You turn a mission's ledger into a set of tasks.

Each task is self-contained: the worker sees its goal and nothing else. Say which
criteria it satisfies and which ledger entries motivated it.

\`dependsOn\` must form a DAG over ids in this plan. A cycle or an unknown id is
rejected before anything runs.

The ledger's dead ends are approaches already shown to fail. Do not propose them
again.

When the input carries \`scope: "quick"\`, a human has looked at this job and said it
is small — a script, a flag, a single well-understood change. Plan it as **one task**
unless that is genuinely impossible, and say why in the goal if you must use more.
Splitting a small job across tasks does not make it safer: each task pays for its own
agent, its own worktree, and its own verification round, and the dependencies between
them are what turn ten minutes of work into an afternoon. Fold what would have been
setup, implementation, and a test into the single task that does all three.

A task whose goal is to *change files in the repository* is \`code\`, whatever else it
is also doing. Only a \`code\` task gets a worktree, a file lease, a commit, and a
verification gate before its work merges; the other kinds run in the shared checkout,
where an edit is uncommitted, unverified, and fails the task. So "audit the code and
fix what you find" is not a \`review\` task — it is a \`review\` task that reports, and a
\`code\` task that fixes, or one \`code\` task doing both. Reading, measuring, and
writing a report are what the other kinds are for.

You may return \`criteria\` to *request* a change to the outcome spec, with your
reasoning in the task goals. After sign-off the request goes to a human — it is never
applied on your say-so.

A criterion's \`command\` check runs as one program with arguments, not through a
shell: no pipes, no \`&&\`, no \`$()\`, no redirects, no \`if\`/\`test\` chains. A check
that needs any of those is refused when it fires and the criterion can never be met.
One program per check — split a chained check into several criteria, name a script a
task has actually left behind, or use a judge rubric over artifacts.

Nor is anything in the string expanded: a quoted argument reaches the program exactly
as written, so a \`\\n\` inside one stays two characters instead of becoming a line
break, and a \`-c\` program whose statements are separated that way fails to parse.
Keep a one-liner genuinely one line, separating statements with \`;\`.

And a check is graded on its exit code, never on its output: it has to exit non-zero
when it fails. \`process.exit(ok ? 0 : 1)\`, an assertion, or a test runner — a
one-liner that prints \`false\` and exits 0 is recorded as met however the work turned
out, and the spec gate refuses that shape at authoring.

${SHAPE}`;

const SYNTHESIZE_PROMPT = `You write the agent that will do one task: its role, its
system prompt, its transport, the tools it holds, and how its work gets checked.

\`tools\` must be names from the \`toolCatalogue\` in the input, and nothing else. That
list is already the mission envelope resolved to concrete tools, so it is the ceiling
— you may take fewer and you can never take more. A name outside it fails validation
whether it is a capability the envelope withheld or a tool that does not exist. Grant
least privilege: a task that only reads should not hold \`Write\` or \`Bash\`.

\`transport.id\` must be one of the \`transports\` listed in the input, which are the
ones that are actually built. Others exist in the design and would fail at dispatch,
so choosing one costs the task a retry and the mission a replan. Both \`cli\` and
\`acp\` run a coding CLI in the task's worktree and need \`transport.target\` set to
one of the \`targets\` listed in the input — those are the agents installed on this
machine, and naming one that is absent fails the same way naming an unbuilt transport
does. Prefer \`acp\` where both are listed: it runs the same CLI over a session with a
permission channel, so a tool outside the grant is asked about instead of blanket-
approved, and the toolset you grant here is actually enforced mid-run.

\`model\` is required. When the input lists \`models\`, it must be one of them and
nothing else — that list is either what this machine's agent can run or what the
person who composed the mission chose, and neither is a default to improve on. When
\`models\` is empty nothing is known about which names are valid, so name the model the
work actually needs. Note that an \`acp\` adapter selects its own model and is never
told yours: on that transport the field is recorded rather than obeyed, so it is not
worth reaching for \`acp\` to get a particular model.

\`modelCards\` appears when this machine has probed a model provider, and lists models
that were actually reached, one per line, as
\`id (tier, context window, input/output price per million tokens) via provider\`. It is
a reference, not a second allowlist: when \`models\` is non-empty that list still decides
what is legal, and a card is only worth naming where the harness you chose can reach the
provider it names. Use it to pick deliberately when \`models\` is empty — a \`worker\` or
\`fast\` tier card for mechanical work, a \`strong\` or \`frontier\` one for work that has
to be right the first time — rather than naming a model from memory.

\`owns\` is required when \`worker\` is \`code\` and must be left out otherwise. It is
the set of file globs this task will write, e.g.
\`["src/routes/health.ts", "test/health.test.ts"]\`. Two workers are running in
parallel worktrees, so this is what stops them editing the same file, and it is checked
again after the worker returns — a file written outside the lease fails the task. Name
the files as narrowly as you can. A broad lease like \`src/**\` is not the safe choice:
it blocks every other task that touches the tree and serializes the mission behind this
one.

When \`worker\` is not \`code\`, the agent runs in the repository checkout with no
worktree and no lease, so anything it writes there is uncommitted and fails the task.
It is given one directory it may write to — its own artifact directory, whose absolute
path the runtime puts in the worker's prompt at dispatch — and that is where a report,
a document, or a data file belongs. Never write a non-code system prompt that tells it
to edit, fix, or clean up the repository. If the task's goal cannot be done without
changing tracked files, it was planned as the wrong kind: say so in \`role\` and keep
the tools read-only, rather than granting \`Write\` and letting it try.

\`env\` is optional and names the environment variables this task needs — names only,
never values, and only names the \`envelope.env\` list in the input already grants. A
name outside it is refused at validation exactly like a tool outside the catalogue, and
widening the envelope is a human decision, so the retry cannot grant it either. Leave
it out unless the work genuinely cannot be done without the value: the worker is given
whatever its transport needs to start and authenticate regardless, so a task almost
never needs this.

\`containment\` is a field you should leave out. The input's \`envelope.containment\`
says whether this mission's workers run on the machine or inside a disposable container
with only the worktree and the artifact directory mounted and no network at all, and
that is the mission's decision, not the task's — setting it to \`"none"\` under a
\`"container"\` envelope is asking to be let out of the sandbox and is refused at
validation like any other capability the envelope withheld. When the envelope says
\`"container"\`, plan the work to be doable in one: no downloads, no package installs,
nothing outside those two directories.

\`outputPath\` is optional and names a file *inside* that directory — \`"report.md"\`,
\`"findings/summary.md"\`. It is relative, always: the runtime decides the directory and
a spec that names an absolute path, or one that climbs out with \`..\`, is refused at
validation and costs the task a retry. Leave it out to write to the directory itself.

\`roster\` lists documented roles, one per line, as
\`name (worker) [suggested capability classes]: description\`. **Prefer naming one.**
Set \`basedOn\` to the role's exact name and the full system prompt for that role — which
you are not shown, and which is longer than anything you would write here — is attached
for you. Then \`systemPrompt\` is only what this *particular* task needs on top of it:
the specific files, the specific constraint, the specific thing to be careful of.
Usually a short paragraph. Do not restate the role, and do not repeat what the role
already covers.

Pick by description and by worker kind. If no role is a reasonable fit, leave
\`basedOn\` out and write a complete \`systemPrompt\` from scratch as you otherwise
would — that is a normal answer, not a failure. What is not allowed is a \`basedOn\`
naming something not on the list: it is refused, costs the task a retry, and the short
addendum you wrote would have been the worker's entire prompt.

Naming a role grants nothing. The capability classes in brackets are a hint about the
shape of the work, not a grant — \`tools\` still comes from \`toolCatalogue\`, and the
transport, the lease, and the envelope are checked exactly as they are for a spec that
named no role at all.

A \`command\` check runs as a program with arguments, not through a shell: no pipes,
no redirects, no \`&&\`, no \`$()\`, no glob expansion, and no shell operators inside a
\`node -e\` one-liner's outer command line. A command that needs any of those is
refused at verification time and the task fails having done its work. Keep it to one
program and its arguments — \`node --test test/range.test.js\`, not a pipeline; if the
check needs logic, have the worker leave a script behind and name that.

Nothing in the string is expanded either: a quoted argument reaches the program
exactly as written, so a \`\\n\` inside one stays a backslash and an \`n\` rather than
becoming a line break, and a \`-e\` or \`-c\` program written that way is a syntax
error. Keep a one-liner genuinely one line, separating statements with \`;\`.

And the exit code is the whole verdict — the output is never read, so a \`command\`
check has to exit non-zero when it fails. \`process.exit(ok ? 0 : 1)\`, an assertion,
or a test runner; a check that prints \`false\` and exits 0 passes every time however
the work turned out, and the spec gate refuses that shape at authoring.

The system prompt is for the worker, which sees no mission context. Write what it
needs to do this task well and nothing about the mission around it.

\`verify\` is how this specific work gets checked, and each kind is evaluated against
something different:

- \`command\` — run in the task's working directory. It passes on exit 0.
- \`judge\` — a separate model grades the rubric **against files on disk**. It is given
  the paths of the artifacts this task wrote and nothing else: not the worker's final
  message, not its summary, not its transcript. Grading a summary written by the thing
  being graded is not verification, so that door is closed and no rubric can open it.
- \`none\` — needs a written reason.

So a rubric that says "the final message must…", "the output must…", or "the report
must contain…" cannot be evaluated and the task fails however well it was done. If the
deliverable is a document, a review, or a set of findings, then **the work has to leave
a file behind**: say so in the system prompt, name it in \`outputPath\` when the task
has no worktree, and write the rubric about that file's contents. And the agent has to
be *able* to leave it — a judge-verified
spec must grant a writing tool (\`Write\`), least privilege notwithstanding; one that
cannot write the artifact its own rubric grades fails validation. If the task genuinely
produces no file, use \`command\` or \`none\` with a reason — never \`judge\`.

Keep the rubric short enough to apply. It is a checklist for a reader who has only the
files, not a specification of the work.

${SHAPE}`;

const PROGRESS_PROMPT = `You judge whether a mission's round moved it forward.

\`isProgressBeingMade\` false means the work is hard. \`isInLoop\` true means the work
is *repeating* — the same approach coming back around. They lead to different
responses, so do not conflate them.

Read \`met\` from each criterion as given. Do not infer that a criterion is met from
the reports; a criterion whose check has not run is not met.

${SHAPE}`;

const JUDGE_BODY = `You decide whether a mission criterion is met, from the
artifacts it produced.

You are given artifact paths rather than the worker's own report, because a summary
written by the thing being graded is not evidence. Open every path you are given and
read it before deciding — you have Read, Glob, and Grep, and nothing that writes.

Your evidence must name the artifacts you relied on and say why they satisfy the
criterion's statement. "It looks done" is not evidence.

If a path will not open, or the artifacts cannot settle the criterion either way,
return \`met: false\` and say exactly that in the evidence. Do not grade what you
could not read, and do not fill the gap from the goal or the rubric alone.`;

/**
 * The judge's system prompt, with its panel seat's lens in it when it has one
 * (PLAN-NEXT 6.1).
 *
 * Composed here rather than concatenated at the call site so the lens lands *before*
 * `SHAPE`. `SHAPE` is the schema instruction and it is last in every prompt in this
 * file; a paragraph appended after it reads as commentary on the JSON rather than on
 * the job, and the one place that was tested was the one place it mattered.
 *
 * No lens hands back the exact string a judge was given before panels existed, which is
 * what makes a quick mission's judge spend unchanged by construction rather than by
 * measurement — `agentCalls.test.ts` pins the equality.
 */
export function judgeSystemPrompt(lens?: string): string {
  const seat = isPanelLens(lens) ? [judgeLens(lens)] : [];
  return [JUDGE_BODY, ...seat, SHAPE].join("\n\n");
}

/** An unknown lens is dropped rather than rejected: it reaches here from the folded log,
 *  and a log written by a newer build naming a lens this one does not have must still be
 *  gradeable. What it costs is the narrowing, not the verdict. */
function isPanelLens(lens: string | undefined): lens is PanelLens {
  return PANEL_LENSES.includes(lens as PanelLens);
}

// ── the transport ──────────────────────────────────────────────────────

/**
 * One-shot, no tools, no filesystem settings. `maxTurns: 1` and an empty tool list
 * are what make this a decision point rather than an agent: it answers the question
 * in the prompt, and the loop decides what happens next.
 */
/**
 * The options a decision point runs under, as a value rather than an inline literal,
 * because one of them was silently wrong and nothing could assert it.
 *
 * `tools: []` is the restriction. `allowedTools: []` — which this used to pass — is
 * the *auto-approve* list, so it left the whole Claude Code toolset in the model's
 * context while reading like the opposite. A `research` prompt naming a file made the
 * model call Read, that consumed the single turn, and the call came back
 * `error_max_turns` with no answer. The names are close enough that the next person
 * would make the same swap, which is why this is a tested function and not a literal.
 */
export function queryOptions(spec: {
  systemPrompt: string;
  prompt: string;
  model: string;
  tools?: string[];
  maxTurns?: number;
  directories?: readonly string[];
  cwd?: string;
}) {
  return {
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    // The mission's repository, not the orchestrator's process directory (P3). A run
    // started from anywhere else had `judge` reading — and every other call reasoning
    // about — whatever directory the terminal happened to be in. Omitted rather than
    // defaulted when nothing was discovered, the same shape as `additionalDirectories`:
    // an invented `cwd` would be a confident wrong answer.
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    // Where the judge is allowed to read, and nowhere else is (defect 40). A task's
    // artifacts live in its *worktree*, which is not under the orchestrator's cwd, so
    // a judge handed correct absolute paths still had every `Read` refused — it said
    // so, returned `met: false`, and failed correct work, which is the right call from
    // an impossible position. Empty for every call but `judge`: the other five have no
    // tools at all, so granting them a directory would widen nothing and mean nothing.
    ...(spec.directories?.length ? { additionalDirectories: [...spec.directories] } : {}),
    // Headroom, not a budget. `maxTurns: 1` reads like "one question, one answer" and
    // is not what it counts: a real `research` call came back `error_max_turns` at
    // num_turns 2 having produced nothing, because a long structured answer spans
    // more turns than the one it was asked for. With `tools: []` there is no loop for
    // a turn cap to interrupt — the ceiling that actually binds is the mission's
    // wall-clock budget (§9.5), so this is only a backstop against a degenerate
    // answer, and it is set where it will not fire on a legitimate one.
    maxTurns: spec.maxTurns ?? MAX_TURNS,
    // §3: a decision point reasons over what the prompt carries and nothing else.
    // `judge` is the sole exception the spec itself creates — see `JUDGE_TOOLS`.
    tools: spec.tools ?? [],
    // Filesystem settings and CLAUDE.md would put whatever is in the repo into every
    // decision point's context, which is the opposite of §4's discipline.
    settingSources: [] as [],
  };
}

const runViaAgentSdk: RunQuery = async ({
  systemPrompt,
  prompt,
  model,
  tools,
  maxTurns,
  directories,
  domains,
  cwd,
  signal,
}) => {
  // Imported lazily so `--plan-only` against a supplied Calls, and every test above
  // this file, never loads the SDK or looks for credentials.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  // What the allowlist refused, reported back so the mission can raise it as a question
  // (PLAN-NEXT 11.3). The decision itself is `webFetchDecision`, which is pure and tested
  // — this closure is the wiring and the recording, which is all that cannot be.
  const denied = new Set<string>();

  const response = query({
    prompt,
    options: {
      ...queryOptions({
        systemPrompt,
        prompt,
        model,
        ...(tools ? { tools } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        ...(directories ? { directories } : {}),
        ...(cwd ? { cwd } : {}),
      }),
      abortController: controller,
      // Only where egress was granted: a call with no tools has nothing to ask about,
      // and a gate wired unconditionally would be a permission channel that decides
      // nothing on every mission but one.
      //
      // `PreToolUse` and not `canUseTool`, which is the same class of mistake as
      // `allowedTools`-for-`tools` one layer along and was caught the same way — by a
      // real run rather than by the suite, this file being below the fixture seam.
      // `canUseTool` is documented as "called before each tool execution" and is not:
      // the CLI consults it only for a call its own rules route to *ask*, and `WebFetch`
      // is auto-allowed. Measured, with a callback that denied everything and recorded
      // every invocation: it was never invoked, and `developer.mozilla.org` — granted by
      // nobody — was fetched and quoted. `permissionMode: "default"` did not change it.
      // A `PreToolUse` hook fires on every tool call whatever the rules decided, its
      // `deny` bypasses `canUseTool` by design, and the call carries on with the refusal
      // as the tool's result, which is the behaviour this grant needs: one refused host
      // must not cost the mission the research it could reach.
      ...(domains === undefined
        ? {}
        : {
            // The allow half, and it is not redundant with the hook. A hook that returns
            // no decision leaves the call to the CLI's ordinary permission flow, which
            // *asks* — and with nothing to answer, `WebSearch` came back as a permission
            // error in a real run and the research pass lost its search tool. So: the
            // hook is the door that always fires and refuses, and this answers the ask
            // for the calls the hook let through. Both read the same pure decision, and
            // `denied` is a Set, so a host that arrives down both paths is recorded once.
            canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
              const decision = webFetchDecision(toolName, toolInput, domains);
              if (decision.allow) return { behavior: "allow" as const, updatedInput: toolInput };
              if (decision.host) denied.add(decision.host);
              return { behavior: "deny" as const, message: decision.message };
            },
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    // `HookInput` is the whole union and one member of it carries no
                    // tool at all, so the narrowing is the compiler's, not a cast. Only
                    // `PreToolUse` is registered, so the other members are unreachable —
                    // allowed rather than denied, because refusing a shape this file does
                    // not understand would fail correct work.
                    async (input: HookInput) => {
                      if (!("tool_name" in input)) return {};
                      const decision = webFetchDecision(input.tool_name, input.tool_input, domains);
                      if (decision.allow) return {};
                      if (decision.host) denied.add(decision.host);
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: "deny" as const,
                          permissionDecisionReason: decision.message,
                        },
                      };
                    },
                  ],
                },
              ],
            },
          }),
    },
  });

  for await (const message of response) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw failedResult(message);
    return {
      text: message.result,
      spend: spendOf(message.usage, message.duration_ms),
      ...(denied.size > 0 ? { deniedHosts: [...denied] } : {}),
    };
  }

  throw new Error(
    "The model call produced no result message. The `claude` CLI exited without " +
      "answering — check `orchestra doctor` and that you are still logged in.",
  );
};

/** A subtype alone is not a fix (§2a rule 5). Each of these has a different cause and
 *  a different thing to do about it, so each says which. */
function failedResult(message: { subtype: string; num_turns?: number }): Error {
  const fixes: Record<string, string> = {
    error_max_turns:
      `It used its one turn without answering — usually a tool call, which a decision ` +
      `point has none of, or a refusal. Check the goal for anything that reads as ` +
      `instructions to the model rather than a mission.`,
    error_max_budget_usd: "Raise the mission budget, or narrow the goal.",
    error_max_structured_output_retries:
      "The model could not produce the call's schema. Narrow the goal and try again.",
    error_during_execution:
      "The `claude` CLI failed mid-call. Run `orchestra doctor` and confirm you are logged in.",
  };

  return new Error(
    `The model call ended as '${message.subtype}' after ${message.num_turns ?? 0} turn(s) ` +
      `with no answer. ${fixes[message.subtype] ?? "Re-run with a narrower goal."}`,
  );
}

/** The SDK reports four numbers and this used to keep one. Input and output are priced
 *  differently and cache is priced differently again, so the sum of the first two is a
 *  figure nobody can turn back into money — which is what "how much did this mission
 *  cost?" needs. All four are carried through; `measured` still means input + output. */
function spendOf(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  ms: number,
): Spend {
  return {
    // Measured, and the portion a mission is actually billed for: the CLI workers
    // ride an existing subscription and the orchestrator does not (§9.5).
    tokens: tokensFrom({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
    }),
    wallMs: ms,
    dispatches: 1,
  };
}
