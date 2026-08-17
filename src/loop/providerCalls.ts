// The decision points against a model card, over an OpenAI-compatible provider
// (PLAN-NEXT 4.2).
//
// This is the second implementation of `loop/calls.ts`, and it is deliberately *not* a
// second copy of `agentCalls.ts`. Everything that decides what a model receives — the six
// system prompts, the schema rendered into each one, the one reformat attempt, the typed
// `CallFormatError` — is the same code, reached by injecting a `RunQuery` that posts to a
// provider instead of driving the Agent SDK. Two prompt sets would drift the first time
// one of them was corrected, and a prompt corrected in one path and not the other is a
// defect no test can see: both paths pass their own suite.
//
// Three facts about this path are load-bearing and none is guessable from the Agent SDK
// half.
//
// **The card is the model, and the requested one is ignored.** `ask` passes
// `PROGRESS_MODEL` — an Anthropic alias — for the progress call, and a mission staffs a
// card per decision point, so the card named for *this* call is the only id that means
// anything at the provider. Sending `sonnet` to Nebius is a 404 on a call that was
// staffed correctly.
//
// **There are no tools here, which is why `judge` is not staffable.** A chat completion
// cannot open a file, and a judge that cannot read the artifacts it grades answers
// `met: false` on correct work — defects 22 and 40. `missionStaffingSchema` has no
// `judge` field, so the refusal is a shape rather than a check anyone can forget.
//
// **`ranOn` comes off the response.** The provider echoes the model it served, and that
// is what `spend_recorded.model` records, so `metrics` prices what ran rather than what
// was asked for.
import { z } from "zod";
import { type DiscoveredConfig } from "../config/discover.js";
import { CALL_NAMES, tokensFrom, type Spend } from "../domain/budget.js";
import { type MissionStaffing } from "../domain/mission.js";
import {
  chatCompletion,
  PROVIDERS,
  type ChatResult,
} from "../providers/openaiCompatible.js";
import { type ModelCard } from "../providers/modelCard.js";
import { renderSchema } from "../runtime/json.js";
import { createAgentCalls, type RunQuery } from "./agentCalls.js";
import { type Calls } from "./calls.js";

/**
 * The `response_format` that constrains an answer to the call's own return type.
 *
 * Pure and its own function because it is the one thing this path can do that the Agent
 * SDK path cannot, and because it is exactly the sort of nested API literal that is wrong
 * invisibly: a provider that does not recognise the wrapper answers in prose, the schema
 * check fails, and the reformat attempt pays for a second call to learn the same thing.
 *
 * `strict` is deliberately absent rather than `true`. OpenAI's strict mode requires every
 * property to be required and `additionalProperties: false` throughout, and half of these
 * schemas have optional fields on purpose (`criteria`, `guesses`, `rejected`) — asking for
 * strict would have the provider refuse the request outright rather than guide the answer.
 * The schema is rendered by `renderSchema`'s own settings so the JSON Schema the provider
 * enforces and the one the prompt shows are the same document.
 */
export function providerResponseFormat(name: string, schema: z.ZodType<unknown>): unknown {
  return {
    type: "json_schema",
    json_schema: { name, schema: JSON.parse(renderSchema(schema)) },
  };
}

export interface ProviderCallsDeps {
  /** The card this decision point was staffed to. Its `id` is the model, its `provider`
   *  is the key of `PROVIDERS` to address. */
  card: ModelCard;
  /** The value, threaded in from `config.providerKeys` — `process.env` is read in two
   *  places in this codebase and this is not a third. */
  apiKey: string;
  onSpend?(call: keyof Calls, spend: Spend, ranOn?: string): void;
  /** Injected so every test above this file runs with no network and no key. */
  chat?: typeof chatCompletion;
  signal?: AbortSignal;
  now?: () => number;
}

/** A decision point as one chat completion. Wall time is measured here because a
 *  provider reports none, and an unmeasured duration would make `metrics --staffing`
 *  unable to answer the question it exists for. */
export function providerRunQuery(deps: ProviderCallsDeps): RunQuery {
  const chat = deps.chat ?? chatCompletion;
  const now = deps.now ?? (() => Date.now());

  return async ({ systemPrompt, prompt, schema }) => {
    const startedAt = now();
    const result: ChatResult = await chat({
      provider: deps.card.provider,
      model: deps.card.id,
      apiKey: deps.apiKey,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      ...(schema === undefined
        ? {}
        : { responseFormat: providerResponseFormat("decision_point", schema) }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });

    return {
      text: result.text,
      spend: {
        // Absent usage stays absent (§9.5): a provider that reported nothing has not
        // reported zero, and `tokensFrom` is what keeps the difference.
        tokens: tokensFrom(result.usage),
        wallMs: Math.max(0, now() - startedAt),
        dispatches: 1,
      },
      // The card's id when the provider did not echo one: a call that answered was
      // served by the model it was addressed to, which is a weaker claim than the echo
      // and a truer one than nothing.
      ranOn: result.ranOn ?? deps.card.id,
    };
  };
}

/**
 * `Calls`, every method running on one card.
 *
 * The whole implementation is `createAgentCalls` with its transport swapped, which is the
 * point: the prompts, the schema-in-the-prompt, the reformat and the error type are the
 * ones a real mission has already been debugged against. `orchestratorModel` is set to the
 * card id so nothing downstream reports a model this path never called.
 */
export function createProviderCalls(
  deps: ProviderCallsDeps & { config: Pick<DiscoveredConfig, "repoRoot" | "cwd"> },
): Calls {
  return createAgentCalls({
    config: { ...deps.config, orchestratorModel: deps.card.id },
    runQuery: providerRunQuery(deps),
    ...(deps.onSpend ? { onSpend: deps.onSpend } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

export type ResolvedStaffing =
  | { ok: true; byCall: Partial<Record<keyof MissionStaffing, ModelCard>> }
  | { ok: false; problem: string };

/**
 * The model-card allowlist door — the one stage 2 deliberately did not build.
 *
 * `inspect()` still refuses `AgentSpec.model` against `models` and still knows nothing
 * about cards, and that stays right: a card's id is a name at *its provider's* API, so
 * putting one in `models` would offer a Nebius id to `cli/claude`. Here the situation is
 * the opposite and the list genuinely is the whole menu — a staffed decision point is
 * called by *this* process against *that* provider, so a card id nobody probed is a call
 * that cannot be made, and the honest place to say so is before the mission opens its log.
 *
 * Pure over the cards and keys it is handed, for `verifiedModelCards`' reason: what a
 * mission may be staffed with has to be assertable with no filesystem and no network.
 * A card whose provider has no key is refused with the variable to set rather than
 * silently dropped — the human named it, so a menu that quietly shrinks is worse than a
 * message.
 */
export function resolveStaffing(
  staffing: MissionStaffing,
  cards: readonly ModelCard[],
  keys: Readonly<Record<string, string>>,
  /** Whether this mission granted `research` read-only egress (PLAN-NEXT 11.3). */
  researchWeb = false,
): ResolvedStaffing {
  const byCall: Partial<Record<keyof MissionStaffing, ModelCard>> = {};

  // A staffed research call cannot hold the tools the grant is made of — a chat
  // completion has none, which is `judge`'s reasoning one call along and defects 22 and
  // 40's class. Honouring the grant on a card would be the `honoursModel` trap: a
  // control that implies something it does not do, and a mission billed for a web pass
  // that read nothing.
  if (researchWeb && staffing.research !== undefined) {
    return {
      ok: false,
      problem:
        `--research-web cannot be combined with --staff research=${staffing.research}. A ` +
        `staffed decision point runs as a chat completion, which holds no tools, so the ` +
        `web grant would do nothing. Drop one of the two.`,
    };
  }

  for (const [call, id] of Object.entries(staffing)) {
    if (id === undefined) continue;

    const card = cards.find((candidate) => candidate.id === id);
    if (!card) {
      const offered = cards.map((candidate) => candidate.id).join(", ");
      return {
        ok: false,
        problem:
          `No verified model card '${id}' to staff '${call}' with` +
          (offered
            ? ` — this machine has: ${offered}.`
            : `. This machine has none: write a card under <stateDir>/providers/ and run ` +
              `'orchestra doctor' to probe it, which is what makes it offerable.`),
      };
    }

    if (!keys[card.provider]) {
      const keyEnv = PROVIDERS[card.provider]?.keyEnv;
      return {
        ok: false,
        problem:
          `Card '${id}' is served by '${card.provider}', which has no key in this ` +
          `environment. Set ${keyEnv ?? `the provider's key variable`} and try again.`,
      };
    }

    byCall[call as keyof MissionStaffing] = card;
  }

  return { ok: true, byCall };
}

/**
 * One `Calls` that routes each decision point to whichever implementation was staffed for
 * it — the dispatcher, pure over the two it is handed.
 *
 * Built by enumerating the interface's own keys rather than writing six properties out,
 * for `resilientCalls`' reason: a seventh decision point added to `Calls` and forgotten
 * here would be a call that silently ignored its staffing. `judge` is never in `byCall`
 * because `missionStaffingSchema` has no field for it, so it falls through to `base` by
 * construction rather than by a check.
 */
export function staffedCalls(
  base: Calls,
  byCall: Partial<Record<keyof MissionStaffing, ModelCard>>,
  forCard: (card: ModelCard) => Calls,
): Calls {
  const perCard = new Map<string, Calls>();
  const routed = {} as Record<keyof Calls, (input: never) => Promise<unknown>>;

  for (const name of CALL_NAMES) {
    const card = byCall[name as keyof MissionStaffing];
    routed[name] = (input: never) => {
      if (!card) return (base[name] as (arg: never) => Promise<unknown>)(input);
      // One client per card rather than one per call: two decision points staffed to the
      // same card share it, and building it lazily keeps a mission that never reaches
      // `synthesize` from constructing the thing that would have run it.
      const existing = perCard.get(card.id) ?? forCard(card);
      perCard.set(card.id, existing);
      return (existing[name] as (arg: never) => Promise<unknown>)(input);
    };
  }

  return routed as unknown as Calls;
}
