// Every failure mode of an HTTP call, as a message that names what to type next.
//
// The header of `openaiCompatible.ts` says a wrong base URL must fail loudly at
// `orchestra doctor` rather than silently shipping a menu, and that is only true if the
// non-2xx path quotes the body — an API refusing a model id says so in the payload and
// nowhere else. The other half these tests hold is §9.5's: a response with no `usage`
// block reports absent tokens, never zero, because a zero would price a real call free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderCallError, chatCompletion } from "./openaiCompatible.js";

const request = {
  provider: "nebius",
  model: "deepseek-ai/DeepSeek-V3",
  apiKey: "k",
  messages: [{ role: "user" as const, content: "ping" }],
};

const responding = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      if (init) seen.init = init;
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;

test("a completion carries its text, its usage and what actually ran", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const result = await chatCompletion(request, {
    fetch: responding(
      200,
      {
        model: "deepseek-ai/DeepSeek-V3-0324",
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      },
      seen,
    ),
  });

  assert.equal(result.text, "pong");
  assert.deepEqual(result.usage, { input: 7, output: 1 });
  // The only place a card's id is proved to resolve — and, when it differs from what was
  // asked for, the 5× pricing error `spend_recorded.model` exists to catch.
  assert.equal(result.ranOn, "deepseek-ai/DeepSeek-V3-0324");
  assert.equal(seen.url, "https://api.studio.nebius.com/v1/chat/completions");
  assert.equal(JSON.parse(String(seen.init?.body)).model, "deepseek-ai/DeepSeek-V3");
});

test("a response with no usage block reports absent tokens, not zero", async () => {
  const result = await chatCompletion(request, {
    fetch: responding(200, { choices: [{ message: { content: "pong" } }] }),
  });

  assert.deepEqual(result.usage, {});
  assert.equal(result.ranOn, undefined);
});

test("a refused model quotes the provider's own words", async () => {
  await assert.rejects(
    () =>
      chatCompletion(request, {
        fetch: responding(404, { error: { message: "model not found" } }),
      }),
    (error: Error) => {
      assert.ok(error instanceof ProviderCallError);
      assert.match(error.message, /HTTP 404/);
      assert.match(error.message, /model not found/);
      assert.match(error.message, /orchestra doctor/);
      return true;
    },
  );
});

test("a provider this build has no address for is refused before any network call", async () => {
  await assert.rejects(
    () =>
      chatCompletion(
        { ...request, provider: "invented" },
        {
          fetch: (() => {
            throw new Error("should never be called");
          }) as unknown as typeof globalThis.fetch,
        },
      ),
    /Known providers: nebius, ollama-cloud/,
  );
});

test("a body that is not a chat completion is a named error, not a crash", async () => {
  await assert.rejects(
    () => chatCompletion(request, { fetch: responding(200, "<html>proxy</html>") }),
    /was not JSON/,
  );
  await assert.rejects(
    () => chatCompletion(request, { fetch: responding(200, { choices: [] }) }),
    /not a chat completion/,
  );
});

test("a transport failure becomes the same error everything else does", async () => {
  await assert.rejects(
    () =>
      chatCompletion(request, {
        fetch: (async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        }) as unknown as typeof globalThis.fetch,
      }),
    /getaddrinfo ENOTFOUND/,
  );
});

// A model that never sends a response header is the one failure whose message used to say
// nothing: undici gives up at 300 s with `TypeError: fetch failed`, the real reason living
// only on `cause.code`. Measured on a VPS — the same `architect` call took 143 s, 187 s and
// over 300 s twice on DeepSeek V4-Flash — and the operator saw `fetch failed` with no move
// to make. These two tests pin that the timeout is named with its fix and that no other
// transport failure was swallowed into it.
test("a header timeout says the model never answered and names the faster seat", async () => {
  const timedOut = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  });

  await assert.rejects(
    () =>
      chatCompletion(request, {
        fetch: (async () => {
          throw timedOut;
        }) as unknown as typeof globalThis.fetch,
      }),
    (error: Error) => {
      assert.ok(error instanceof ProviderCallError);
      assert.match(error.message, /no response header within 300 seconds/);
      // The fix, not the symptom: a slower card on this seat is the cause and --staff is
      // the lever. 'fetch failed' said none of this.
      assert.match(error.message, /--staff/);
      assert.doesNotMatch(error.message, /fetch failed/);
      return true;
    },
  );
});

test("a transport failure that is not a header timeout still reports its own message", async () => {
  await assert.rejects(
    () =>
      chatCompletion(request, {
        fetch: (async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        }) as unknown as typeof globalThis.fetch,
      }),
    (error: Error) => {
      assert.match(error.message, /fetch failed/);
      assert.doesNotMatch(error.message, /no response header/);
      assert.doesNotMatch(error.message, /--staff/);
      // The path everything else lands on, unchanged.
      assert.match(error.message, /orchestra doctor/);
      return true;
    },
  );
});
