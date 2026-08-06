// The five decision points, against a real model (§3). The first thing in Phase 2
// that costs money, and the only part that cannot be tested for free — which is why
// everything above it is written against the `Calls` interface instead of this file.
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
//   No tools. A decision point reasons over what the prompt carries and nothing
//   else. Letting it read files would quietly reintroduce the context growth the
//   whole loop architecture exists to avoid.
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
import { extractJsonObject } from "../runtime/json.js";
import {
  type Calls,
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
  signal?: AbortSignal;
}) => Promise<{ text: string; spend: Spend }>;

export interface AgentCallsDeps {
  config: Pick<DiscoveredConfig, "orchestratorModel">;
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

export function createAgentCalls(deps: AgentCallsDeps): Calls {
  const run = deps.runQuery ?? runViaAgentSdk;
  const model = deps.config.orchestratorModel;

  const ask = async <T>(
    call: keyof Calls,
    spec: { systemPrompt: string; prompt: string; schema: z.ZodType<T>; model?: string },
  ): Promise<T> => {
    const systemPrompt = withSchema(spec.systemPrompt, spec.schema);

    const attempt = async (prompt: string) => {
      const result = await run({
        systemPrompt,
        prompt,
        model: spec.model ?? model,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      deps.onSpend?.(call, result.spend);
      return validate(result.text, spec.schema);
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

    throw new CallFormatError(call, second.problem);
  };

  return {
    research: (input) =>
      ask("research", {
        systemPrompt: RESEARCH_PROMPT,
        prompt: describe("Research request", input),
        schema: researchSchema,
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

/** One renderer, so a prompt that quotes a nested type quotes the same thing the
 *  boundary will validate against. */
const renderSchema = (schema: z.ZodType<unknown>): string =>
  JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), null, 2);

export class CallFormatError extends Error {
  readonly call: keyof Calls;

  constructor(call: keyof Calls, problem: string) {
    super(
      `The '${call}' decision point did not return its schema after one reformat ` +
        `attempt: ${problem}. The loop cannot continue on an unparseable answer.`,
    );
    this.name = "CallFormatError";
    this.call = call;
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

${SHAPE}`;

const PLAN_PROMPT = `You turn a mission's ledger into a set of tasks.

Each task is self-contained: the worker sees its goal and nothing else. Say which
criteria it satisfies and which ledger entries motivated it.

\`dependsOn\` must form a DAG over ids in this plan. A cycle or an unknown id is
rejected before anything runs.

The ledger's dead ends are approaches already shown to fail. Do not propose them
again.

You may return \`criteria\` to *request* a change to the outcome spec, with your
reasoning in the task goals. After sign-off the request goes to a human — it is never
applied on your say-so.

${SHAPE}`;

const SYNTHESIZE_PROMPT = `You write the agent that will do one task: its role, its
system prompt, its transport, and how its work gets checked.

Draw tools only from the envelope you are given. You may narrow it and never widen
it — a request for anything outside it fails validation.

The system prompt is for the worker, which sees no mission context. Write what it
needs to do this task well and nothing about the mission around it.

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
written by the thing being graded is not evidence. Read the artifacts.

Your evidence must name the artifacts you relied on and say why they satisfy the
criterion's statement. "It looks done" is not evidence.

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
export function queryOptions(spec: { systemPrompt: string; prompt: string; model: string }) {
  return {
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    // Headroom, not a budget. `maxTurns: 1` reads like "one question, one answer" and
    // is not what it counts: a real `research` call came back `error_max_turns` at
    // num_turns 2 having produced nothing, because a long structured answer spans
    // more turns than the one it was asked for. With `tools: []` there is no loop for
    // a turn cap to interrupt — the ceiling that actually binds is the mission's
    // wall-clock budget (§9.5), so this is only a backstop against a degenerate
    // answer, and it is set where it will not fire on a legitimate one.
    maxTurns: MAX_TURNS,
    // §3: a decision point reasons over what the prompt carries and nothing else.
    tools: [] as string[],
    // Filesystem settings and CLAUDE.md would put whatever is in the repo into every
    // decision point's context, which is the opposite of §4's discipline.
    settingSources: [] as [],
  };
}

const runViaAgentSdk: RunQuery = async ({ systemPrompt, prompt, model, signal }) => {
  // Imported lazily so `--plan-only` against a supplied Calls, and every test above
  // this file, never loads the SDK or looks for credentials.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = query({
    prompt,
    options: {
      ...queryOptions({ systemPrompt, prompt, model }),
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
