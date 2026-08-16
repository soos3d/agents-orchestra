// One adapter for every provider that speaks OpenAI's chat-completions shape
// (PLAN-NEXT 2.2).
//
// There is no SDK here and there should not be one: setup simplicity is a hard constraint,
// the request is a JSON POST, and `fetch` has been in Node since 18. A dependency would buy
// retry and streaming, neither of which this needs — `resilience.ts` already owns retry, and
// a decision point wants one whole answer rather than a stream.
//
// **A provider entry is an address, not an endorsement.** Base URLs and key names are
// written down here so a probe has somewhere to knock; nothing about a model is offered
// until `probeProviders` has actually reached it and written a transcript
// (`modelCard.ts`). That split is deliberate. It means a wrong base URL fails loudly at
// `orchestra doctor` with the response body quoted, instead of silently shipping a menu of
// models nobody called.
//
// Key *names* live here and key *values* never do: `config/discover.ts` is one of the two
// places `process.env` is read in this codebase, and it stays that way — the value is
// threaded in as an argument.
import { z } from "zod";
import { type TokenUsage } from "../domain/budget.js";

export interface Provider {
  /** Everything up to and including `/v1`; `/chat/completions` is appended. */
  readonly baseUrl: string;
  /** The environment variable holding this provider's key. Read in `config/discover.ts`
   *  and nowhere else. */
  readonly keyEnv: string;
}

/**
 * The providers this build knows how to address.
 *
 * Two, because two is what PLAN-NEXT names and a third with no card behind it would be
 * scaffolding. Adding one is this object plus a card file — no code path branches on the
 * key.
 */
export const PROVIDERS: Readonly<Record<string, Provider>> = {
  nebius: { baseUrl: "https://api.studio.nebius.com/v1", keyEnv: "NEBIUS_API_KEY" },
  "ollama-cloud": { baseUrl: "https://ollama.com/v1", keyEnv: "OLLAMA_API_KEY" },
};

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  /** Passed through as `response_format`. Stage 4's JSON-schema path is the reason it is
   *  `unknown` rather than typed: the shape is the API's, not this codebase's, and
   *  narrowing it here would be a second schema to keep in step with theirs. */
  readonly responseFormat?: unknown;
  readonly signal?: AbortSignal;
}

export interface ChatResult {
  readonly text: string;
  readonly usage: TokenUsage;
  /** What the API says it ran, which is the only thing that proves a card's id resolves.
   *  Absent when the response omitted it. */
  readonly ranOn?: string;
}

/** The half of the response this code reads, at the boundary, with everything else
 *  ignored — an API adding a field must never fail a call that answered correctly. */
const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class ProviderCallError extends Error {
  constructor(provider: string, model: string, problem: string) {
    super(
      `Provider '${provider}' could not answer for model '${model}': ${problem} ` +
        `Check the model id on its card, the key in the provider's environment variable, ` +
        `and that the provider is reachable — 'orchestra doctor' probes all three.`,
    );
    this.name = "ProviderCallError";
  }
}

export interface ChatDeps {
  /** Injected so the whole adapter is testable without a network. Defaults to the
   *  global, which is what every real caller uses. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One chat completion, or a `ProviderCallError` naming what to fix.
 *
 * Every failure lands as that one error type — an unknown provider, a non-2xx, a body that
 * is not JSON, a response with no text. They are one class because the caller's move is
 * the same for all of them and because the alternative, a raw `TypeError: fetch failed`,
 * is exactly the message this codebase's error rule exists to forbid.
 */
export async function chatCompletion(
  request: ChatRequest,
  deps: ChatDeps = {},
): Promise<ChatResult> {
  const provider = PROVIDERS[request.provider];
  if (!provider) {
    throw new ProviderCallError(
      request.provider,
      request.model,
      `this build has no base URL for it. Known providers: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }

  const call = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await call(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.responseFormat === undefined
          ? {}
          : { response_format: request.responseFormat }),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throw new ProviderCallError(request.provider, request.model, `${(error as Error).message}.`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new ProviderCallError(
      request.provider,
      request.model,
      `HTTP ${response.status}: ${body.slice(0, 400)}.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ProviderCallError(
      request.provider,
      request.model,
      `the response was not JSON: ${body.slice(0, 200)}.`,
    );
  }

  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderCallError(
      request.provider,
      request.model,
      `the response is not a chat completion (${parsed.error.issues[0]?.message ?? "unknown"}).`,
    );
  }

  const text = parsed.data.choices[0]?.message?.content ?? "";
  const usage = parsed.data.usage;

  return {
    text,
    // Absent stays absent: a provider that reported no usage block has not reported zero
    // tokens, and a zero here would price a real call as free (§9.5).
    usage: {
      ...(usage?.prompt_tokens === undefined ? {} : { input: usage.prompt_tokens }),
      ...(usage?.completion_tokens === undefined ? {} : { output: usage.completion_tokens }),
    },
    ...(parsed.data.model === undefined ? {} : { ranOn: parsed.data.model }),
  };
}
