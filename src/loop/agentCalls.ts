// The five decision points, against a real model (§3).
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
import { z } from "zod";
import { type DiscoveredConfig } from "../config/discover.js";
import { evidenceSchema } from "../domain/artifacts.js";
import { type Spend } from "../domain/budget.js";
import {
  criterionSchema,
  findingSchema,
  guessSchema,
  plannedTaskSchema,
  progressLedgerSchema,
} from "../domain/ledger.js";
import { agentSpecSchema } from "../domain/task.js";
import { extractJsonObject, renderSchema } from "../runtime/json.js";
import {
  type Calls,
  type IntakeResult,
  type JudgeResult,
  type PlanResult,
  type ResearchResult,
} from "./calls.js";

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
  /** The mission's repository. Absent only when nothing was discovered (P3). */
  cwd?: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; spend: Spend }>;

export interface AgentCallsDeps {
  // `repoRoot` and `cwd` are here because P3 was a defect a type was hiding: this was
  // `Pick<…, "orchestratorModel">` while `createAgentCalls` was handed the whole
  // config, so every call site read correctly and the mission's own repository was
  // dropped at the boundary. A decision point then ran wherever the terminal was.
  config: Pick<DiscoveredConfig, "orchestratorModel" | "repoRoot" | "cwd">;
  /** Where the measured portion of the mission's spend is recorded (§9.5). */
  onSpend?(call: keyof Calls, spend: Spend): void;
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
        ...(spec.directories ? { directories: spec.directories } : {}),
        ...(cwd ? { cwd } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      deps.onSpend?.(call, result.spend);
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
    research: (input) =>
      ask("research", {
        systemPrompt: RESEARCH_PROMPT,
        prompt: describe("Research request", input),
        schema: researchSchema,
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
        systemPrompt: JUDGE_PROMPT,
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

const RESEARCH_PROMPT = `You research a mission before it is planned, and write the
outcome spec it will be judged against.

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

Each entry in \`criteria\` has this shape. It is spelled out here because the return
schema below types \`criteria\` as an open array on purpose — that is what lets an
uncheckable criterion reach the gate that rejects it, rather than being silently
dropped at the boundary. Getting the shape right is still on you:

${renderSchema(criterionSchema)}

Note the \`check\` union: \`command\` needs a \`command\` string, \`judge\` needs a
\`rubric\`, and \`none\` needs a \`reason\` justifying why nothing can check it.

A \`command\` check runs as one program with arguments, not through a shell: no
pipes, no \`&&\`, no \`$()\`, no redirects, no glob expansion. A check that needs any
of those is refused when it fires and the criterion can never be met, however good
the work was. \`node --test test/foo.test.js\` is a check; a grep chained to a test
run is two checks — write two criteria, or fold the logic into a judge rubric.

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
the one that suits the task — \`claude\` or \`codex\` — whatever kind of work it is.
Prefer \`acp\` where both are listed: it runs the same CLI over a session with a
permission channel, so a tool outside the grant is asked about instead of blanket-
approved, and the toolset you grant here is actually enforced mid-run.

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
Give a non-code agent a system prompt that says what to produce and where — a report,
a document, a data file outside the tracked tree — and never one that tells it to edit,
fix, or clean up the repository. If the task's goal cannot be done without changing
tracked files, it was planned as the wrong kind: say so in \`role\` and keep the tools
read-only, rather than granting \`Write\` and letting it try.

Anything under \`profiles\` is an agent a human kept from an earlier mission — prior
art, not a roster. Adapt one where it fits this task, or ignore them all and write
something new; nothing here is preferred for being saved, and a profile's tools,
transport, and lease are checked against *this* mission's envelope like any other, so
copying one across does not carry its capabilities with it.

A \`command\` check runs as a program with arguments, not through a shell: no pipes,
no redirects, no \`&&\`, no \`$()\`, no glob expansion, and no shell operators inside a
\`node -e\` one-liner's outer command line. A command that needs any of those is
refused at verification time and the task fails having done its work. Keep it to one
program and its arguments — \`node --test test/range.test.js\`, not a pipeline; if the
check needs logic, have the worker leave a script behind and name that.

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
a file behind**: say so in the system prompt, name the path, and write the rubric about
that file's contents. And the agent has to be *able* to leave it — a judge-verified
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

const JUDGE_PROMPT = `You decide whether a mission criterion is met, from the
artifacts it produced.

You are given artifact paths rather than the worker's own report, because a summary
written by the thing being graded is not evidence. Open every path you are given and
read it before deciding — you have Read, Glob, and Grep, and nothing that writes.

Your evidence must name the artifacts you relied on and say why they satisfy the
criterion's statement. "It looks done" is not evidence.

If a path will not open, or the artifacts cannot settle the criterion either way,
return \`met: false\` and say exactly that in the evidence. Do not grade what you
could not read, and do not fill the gap from the goal or the rubric alone.

${SHAPE}`;

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
  cwd,
  signal,
}) => {
  // Imported lazily so `--plan-only` against a supplied Calls, and every test above
  // this file, never loads the SDK or looks for credentials.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

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
    },
  });

  for await (const message of response) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw failedResult(message);
    return { text: message.result, spend: spendOf(message.usage, message.duration_ms) };
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

function spendOf(usage: { input_tokens?: number; output_tokens?: number }, ms: number): Spend {
  return {
    // Measured, and the portion a mission is actually billed for: the CLI workers
    // ride an existing subscription and the orchestrator does not (§9.5).
    tokens: {
      measured: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      estimated: 0,
      unmeasured: 0,
    },
    wallMs: ms,
    dispatches: 1,
  };
}
