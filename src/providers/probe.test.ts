// The door itself: a transcript on disk is the whole difference between a card that is
// offered and one that is not, so the two facts worth pinning are that a *failed* probe
// leaves nothing behind and that a provider with no key is never even tried.
//
// The first is the one that would rot quietly. Writing a transcript before checking the
// answer would keep offering a model after it was withdrawn — the card's evidence would
// outlive the thing it was evidence of.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ModelCard, probePath, staffableCards } from "./modelCard.js";
import { probeProviders } from "./probe.js";

const card: ModelCard = {
  id: "deepseek-ai/DeepSeek-V3",
  provider: "nebius",
  access: "api-key",
  tier: "worker",
  contextK: 128,
  costInPer1M: 0.13,
  costOutPer1M: 0.4,
  verifiedBy: "probes/nebius-v3.json",
};

const stateDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-probe-"));

const answering = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;

test("a probe that is answered writes the transcript the card names", async () => {
  const dir = stateDir();
  const outcomes = await probeProviders(
    {
      stateDir: dir,
      keys: { nebius: "k" },
      fetch: answering(200, {
        model: "deepseek-ai/DeepSeek-V3-0324",
        choices: [{ message: { content: "." } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      now: () => "2026-08-16T00:00:00.000Z",
    },
    [card],
  );

  assert.deepEqual(outcomes, [{ card, ok: true, ranOn: "deepseek-ai/DeepSeek-V3-0324" }]);

  const file = probePath(dir, card.verifiedBy);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.requested, "deepseek-ai/DeepSeek-V3");
  assert.equal(written.ranOn, "deepseek-ai/DeepSeek-V3-0324");
  assert.deepEqual(written.usage, { input: 3, output: 1 });
  // The key is never part of the evidence: a transcript is a file somebody will paste
  // into an issue.
  assert.ok(!fs.readFileSync(file, "utf8").includes("k\""));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a probe that fails leaves no evidence behind", async () => {
  const dir = stateDir();
  const outcomes = await probeProviders(
    { stateDir: dir, keys: { nebius: "k" }, fetch: answering(404, { error: "no such model" }) },
    [card],
  );

  assert.equal(outcomes[0]?.ok, false);
  assert.equal(fs.existsSync(probePath(dir, card.verifiedBy)), false);
});

test("a provider with no key is skipped rather than reported as broken", async () => {
  const outcomes = await probeProviders(
    {
      stateDir: stateDir(),
      keys: {},
      fetch: (() => {
        throw new Error("should never be called");
      }) as unknown as typeof globalThis.fetch,
    },
    [card],
  );

  // Absent from the result entirely: nothing was tried, so nothing is claimed.
  assert.deepEqual(outcomes, []);
});

test("the probe is what puts a card on the menu, end to end", async () => {
  const dir = stateDir();
  fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "providers", "nebius.json"), JSON.stringify([card]));

  assert.deepEqual(staffableCards(dir), []);

  await probeProviders(
    {
      stateDir: dir,
      keys: { nebius: "k" },
      fetch: answering(200, { model: card.id, choices: [{ message: { content: "." } }] }),
    },
    [card],
  );

  assert.deepEqual(staffableCards(dir), [card]);
});
