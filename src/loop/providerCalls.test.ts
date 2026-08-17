// The failure modes here are the ones a green suite cannot see on its own: a decision
// point staffed to a card and called on the *default* model anyway, a card id nobody
// probed reaching a provider as a 404 after the mission has already opened its log, and
// a `response_format` shaped so the provider refuses the request rather than constraining
// the answer.
//
// The dispatcher is the one worth the most attention. Its two mistakes are opposite and
// both silent: routing a call that was never staffed (the mission quietly changes model),
// and failing to route one that was (the flag does nothing at all).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { emptyLedger } from "../domain/ledger.js";
import { type ModelCard } from "../providers/modelCard.js";
import { anEnvelope } from "../testing/fixtures.js";
import { type ChatRequest, type ChatResult } from "../providers/openaiCompatible.js";
import { CALL_NAMES } from "../domain/budget.js";
import { type Calls } from "./calls.js";
import {
  createProviderCalls,
  providerResponseFormat,
  providerRunQuery,
  resolveStaffing,
  staffedCalls,
} from "./providerCalls.js";

const aCard = (patch: Partial<ModelCard> = {}): ModelCard => ({
  id: "Qwen/Qwen3-4B-fast",
  provider: "nebius",
  access: "api-key",
  tier: "fast",
  contextK: 128,
  costInPer1M: 0.1,
  costOutPer1M: 0.3,
  verifiedBy: "nebius/qwen3-4b-fast.json",
  ...patch,
});

const answered = (text: string): ChatResult => ({
  text,
  usage: { input: 8, output: 4 },
  ranOn: "Qwen/Qwen3-4B-fast",
});

describe("providerResponseFormat", () => {
  test("carries the call's own schema, not a bare json_object", () => {
    const format = providerResponseFormat("decision_point", z.object({ met: z.boolean() })) as {
      type: string;
      json_schema: { name: string; schema: { properties: Record<string, unknown> } };
    };

    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.name, "decision_point");
    assert.ok("met" in format.json_schema.schema.properties, "the field names were dropped");
  });

  // Strict mode requires every property present and additionalProperties false, and half
  // these schemas have deliberately optional fields. Asking for it has the provider refuse
  // the request outright, which fails a call that was staffed correctly.
  test("does not ask for strict mode, which these schemas cannot satisfy", () => {
    const format = providerResponseFormat("decision_point", z.object({ a: z.string().optional() }));

    assert.equal(JSON.stringify(format).includes('"strict"'), false);
  });
});

describe("providerRunQuery", () => {
  test("calls the card's own model, never the one the call asked for", async () => {
    const seen: ChatRequest[] = [];
    const run = providerRunQuery({
      card: aCard(),
      apiKey: "k",
      chat: async (request) => {
        seen.push(request);
        return answered("{}");
      },
    });

    // `sonnet` is what `ask` passes for the progress call — an Anthropic alias, and a 404
    // at any provider that is not Anthropic.
    await run({ systemPrompt: "s", prompt: "p", model: "sonnet" });

    assert.equal(seen[0]?.model, "Qwen/Qwen3-4B-fast");
    assert.equal(seen[0]?.provider, "nebius");
  });

  test("sends the system prompt and the input as two messages", async () => {
    let seen: ChatRequest | undefined;
    const run = providerRunQuery({
      card: aCard(),
      apiKey: "k",
      chat: async (request) => {
        seen = request;
        return answered("{}");
      },
    });

    await run({ systemPrompt: "you plan", prompt: "the request", model: "x" });

    assert.deepEqual(seen?.messages, [
      { role: "system", content: "you plan" },
      { role: "user", content: "the request" },
    ]);
  });

  test("reports what the provider says answered, not what was asked for", async () => {
    const run = providerRunQuery({
      card: aCard(),
      apiKey: "k",
      chat: async () => ({ ...answered("{}"), ranOn: "Qwen/Qwen3-4B-fast-0925" }),
    });

    assert.equal((await run({ systemPrompt: "s", prompt: "p", model: "x" })).ranOn, "Qwen/Qwen3-4B-fast-0925");
  });

  test("falls back to the card id when the provider echoed nothing", async () => {
    const run = providerRunQuery({
      card: aCard(),
      apiKey: "k",
      chat: async () => ({ text: "{}", usage: {} }),
    });

    assert.equal((await run({ systemPrompt: "s", prompt: "p", model: "x" })).ranOn, "Qwen/Qwen3-4B-fast");
  });

  test("measures the wall time a provider does not report", async () => {
    let clock = 1000;
    const run = providerRunQuery({
      card: aCard(),
      apiKey: "k",
      now: () => clock,
      chat: async () => {
        clock = 3500;
        return answered("{}");
      },
    });

    assert.equal((await run({ systemPrompt: "s", prompt: "p", model: "x" })).spend.wallMs, 2500);
  });
});

describe("createProviderCalls", () => {
  test("runs a real decision point end to end and records what it cost", async () => {
    const spends: { call: keyof Calls; measured: number; ranOn?: string }[] = [];
    const calls = createProviderCalls({
      card: aCard(),
      apiKey: "k",
      config: { cwd: "/repo" },
      onSpend: (call, spend, ranOn) =>
        spends.push({ call, measured: spend.tokens.measured, ...(ranOn ? { ranOn } : {}) }),
      chat: async () =>
        answered(
          JSON.stringify({ tasks: [], criteria: [] }),
        ),
    });

    const result = await calls.plan({
      goal: "g",
      ledger: emptyLedger(),
      envelope: anEnvelope(),
    });

    assert.deepEqual(result.tasks, []);
    assert.deepEqual(spends, [{ call: "plan", measured: 12, ranOn: "Qwen/Qwen3-4B-fast" }]);
  });

  test("sends the call's return type as the response format", async () => {
    let seen: ChatRequest | undefined;
    const calls = createProviderCalls({
      card: aCard(),
      apiKey: "k",
      config: { cwd: "/repo" },
      chat: async (request) => {
        seen = request;
        return answered(JSON.stringify({ questions: [] }));
      },
    });

    await calls.intake({ goal: "g", findings: [], known: [], envelope: anEnvelope() });

    const format = seen?.responseFormat as { json_schema: { schema: { properties: Record<string, unknown> } } };
    assert.ok("questions" in format.json_schema.schema.properties, "intake's own schema was not sent");
  });
});

describe("resolveStaffing", () => {
  test("resolves a card the machine has verified", () => {
    const resolved = resolveStaffing({ plan: "Qwen/Qwen3-4B-fast" }, [aCard()], { nebius: "k" });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok && resolved.byCall.plan?.id, "Qwen/Qwen3-4B-fast");
  });

  // The door stage 2 left for this stage: here the card list really is the whole menu,
  // because the call is made by this process against that provider.
  test("refuses a card id nobody probed, and names what there is", () => {
    const resolved = resolveStaffing({ plan: "deepseek-v4" }, [aCard()], { nebius: "k" });

    assert.equal(resolved.ok, false);
    assert.match(resolved.ok ? "" : resolved.problem, /no verified model card 'deepseek-v4'/i);
    assert.match(resolved.ok ? "" : resolved.problem, /Qwen\/Qwen3-4B-fast/);
  });

  test("with no cards at all, says how a card becomes offerable", () => {
    const resolved = resolveStaffing({ plan: "anything" }, [], {});

    assert.equal(resolved.ok, false);
    assert.match(resolved.ok ? "" : resolved.problem, /orchestra doctor/);
  });

  // Silently dropping it would be the worse answer: the human named the card, so a menu
  // that quietly shrinks hides the one thing they have to fix.
  test("refuses a card whose provider has no key, naming the variable", () => {
    const resolved = resolveStaffing({ plan: "Qwen/Qwen3-4B-fast" }, [aCard()], {});

    assert.equal(resolved.ok, false);
    assert.match(resolved.ok ? "" : resolved.problem, /NEBIUS_API_KEY/);
  });

  test("an empty staffing resolves to nothing routed", () => {
    const resolved = resolveStaffing({}, [aCard()], { nebius: "k" });

    assert.deepEqual(resolved.ok && resolved.byCall, {});
  });
});

describe("staffedCalls", () => {
  const trace = (label: string, seen: string[]): Calls =>
    Object.fromEntries(
      CALL_NAMES.map((name) => [
        name,
        async () => {
          seen.push(`${label}:${name}`);
          return {} as never;
        },
      ]),
    ) as unknown as Calls;

  test("routes a staffed decision point to its card and leaves the rest alone", async () => {
    const seen: string[] = [];
    const calls = staffedCalls(trace("sdk", seen), { plan: aCard() }, () => trace("card", seen));

    await calls.plan({} as never);
    await calls.research({} as never);
    await calls.judge({} as never);

    assert.deepEqual(seen, ["card:plan", "sdk:research", "sdk:judge"]);
  });

  // PLAN-NEXT 5. The dispatcher enumerates `CALL_NAMES` rather than naming properties,
  // which is what made `architect` and `critique` routable the moment they existed — and
  // `judge` still falls through by construction, because `missionStaffingSchema` has no
  // field for it and a chat completion cannot open the artifacts it grades.
  test("routes the two decision points PLAN-NEXT 5 added, and still never the judge", async () => {
    const seen: string[] = [];
    const calls = staffedCalls(
      trace("sdk", seen),
      { architect: aCard(), critique: aCard() },
      () => trace("card", seen),
    );

    await calls.architect({} as never);
    await calls.critique({} as never);
    await calls.judge({} as never);

    assert.deepEqual(seen, ["card:architect", "card:critique", "sdk:judge"]);
  });

  test("with nothing staffed, every call is the one it was before", async () => {
    const seen: string[] = [];
    const calls = staffedCalls(trace("sdk", seen), {}, () => {
      throw new Error("built a provider client for a mission that staffed nothing");
    });

    await calls.progress({} as never);
    await calls.synthesize({} as never);

    assert.deepEqual(seen, ["sdk:progress", "sdk:synthesize"]);
  });

  test("two decision points on one card share a single client", async () => {
    let built = 0;
    const seen: string[] = [];
    const card = aCard();
    const calls = staffedCalls(trace("sdk", seen), { plan: card, research: card }, () => {
      built += 1;
      return trace("card", seen);
    });

    await calls.plan({} as never);
    await calls.research({} as never);

    assert.equal(built, 1);
  });
});

// The failure mode: a mission that granted research the web *and* staffed it to a card,
// where the card is a chat completion holding no tools — the grant would be silently
// dropped, which is the `honoursModel` trap and defects 22 and 40's class
// (PLAN-NEXT 11.3).
describe("resolveStaffing and the web grant", () => {
  test("refuses the pair, naming both flags", () => {
    const resolved = resolveStaffing(
      { research: "Qwen/Qwen3-4B-fast" },
      [aCard()],
      { nebius: "k" },
      true,
    );

    assert.equal(resolved.ok, false);
    assert.match(resolved.ok ? "" : resolved.problem, /--research-web/);
    assert.match(resolved.ok ? "" : resolved.problem, /--staff research=/);
  });

  test("either alone still resolves", () => {
    assert.equal(
      resolveStaffing({ research: "Qwen/Qwen3-4B-fast" }, [aCard()], { nebius: "k" }).ok,
      true,
    );
    assert.equal(resolveStaffing({ plan: "Qwen/Qwen3-4B-fast" }, [aCard()], { nebius: "k" }, true).ok, true);
  });
});
