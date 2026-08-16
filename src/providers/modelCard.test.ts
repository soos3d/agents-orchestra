// The failure this file is about: a model offered on rates and a context size nobody
// checked. A card is evidence — `verifiedBy` is required at parse and the offer is
// narrowed to the cards a probe answered for — and each test below is one way that door
// can be left ajar: a card without a transcript, a transcript path pointing outside the
// state directory, a hand-edited file that no longer parses, and an index that grows past
// what a synthesize call can afford to read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CARD_INDEX_BUDGET,
  costOf,
  loadModelCards,
  modelCardIndex,
  parseModelCards,
  probePath,
  verifiedModelCards,
} from "./modelCard.js";

const card = (over: Record<string, unknown> = {}) => ({
  id: "deepseek-ai/DeepSeek-V3",
  provider: "nebius",
  access: "api-key",
  tier: "worker",
  contextK: 128,
  costInPer1M: 0.13,
  costOutPer1M: 0.4,
  verifiedBy: "probes/nebius-v3.json",
  ...over,
});

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-cards-"));

test("a card with no evidence does not parse", () => {
  const { verifiedBy, ...withoutEvidence } = card();
  void verifiedBy;
  const parsed = parseModelCards(JSON.stringify([withoutEvidence]));

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.problem, /verifiedBy/);
  // The message names the fix rather than quoting a zod path at somebody.
  assert.match(parsed.ok ? "" : parsed.problem, /JSON array of model cards/);
});

test("a tier or access value outside the vocabulary does not parse", () => {
  assert.equal(parseModelCards(JSON.stringify([card({ tier: "cheap" })])).ok, false);
  assert.equal(parseModelCards(JSON.stringify([card({ access: "free" })])).ok, false);
});

test("a file that is not JSON is a problem, not a crash", () => {
  const parsed = parseModelCards("{ half a file");
  assert.equal(parsed.ok, false);
});

test("later directories shadow earlier ones by id, and a broken file is skipped", () => {
  const shipped = tmpDir();
  const local = tmpDir();
  fs.writeFileSync(path.join(shipped, "nebius.json"), JSON.stringify([card(), card({ id: "b" })]));
  // The correction a machine makes without editing inside node_modules.
  fs.writeFileSync(path.join(local, "nebius.json"), JSON.stringify([card({ costInPer1M: 9 })]));
  fs.writeFileSync(path.join(local, "broken.json"), "not json");

  const warnings: string[] = [];
  const cards = loadModelCards([shipped, local], (message) => warnings.push(message));

  assert.deepEqual(
    cards.map((entry) => [entry.id, entry.costInPer1M]),
    [["b", 0.13], ["deepseek-ai/DeepSeek-V3", 9]],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /broken\.json/);
});

test("a missing directory is an empty offer rather than an error", () => {
  assert.deepEqual(loadModelCards([path.join(tmpDir(), "nothing-here")]), []);
});

test("a card whose probe never ran is not offered", () => {
  const parsed = parseModelCards(
    JSON.stringify([card(), card({ id: "unprobed", verifiedBy: "probes/unprobed.json" })]),
  );
  assert.ok(parsed.ok);

  const offered = verifiedModelCards(parsed.cards, (verifiedBy) =>
    verifiedBy === "probes/nebius-v3.json",
  );

  assert.deepEqual(offered.map((entry) => entry.id), ["deepseek-ai/DeepSeek-V3"]);
});

test("a card whose evidence points outside the state directory is refused, not resolved", () => {
  // Absolute and `..` both, because a card is a hand-edited JSON file and either one
  // turns "verified" into "this path happens to exist on the disk".
  assert.throws(() => probePath("/state", "/etc/passwd"), /Refusing to resolve/);
  assert.throws(() => probePath("/state", "../../etc/passwd"), /Refusing to resolve/);
  assert.equal(probePath("/state", "probes/x.json"), path.join("/state", "providers", "probes", "x.json"));

  // And the narrowing treats a refused path as no evidence rather than propagating.
  const parsed = parseModelCards(JSON.stringify([card({ verifiedBy: "../escape.json" })]));
  assert.ok(parsed.ok);
  assert.deepEqual(
    verifiedModelCards(parsed.cards, (verifiedBy) => {
      probePath("/state", verifiedBy);
      return true;
    }),
    [],
  );
});

test("the index renders what a staffing choice is made on, and stays inside its budget", () => {
  const parsed = parseModelCards(JSON.stringify([card()]));
  assert.ok(parsed.ok);
  const index = modelCardIndex(parsed.cards);

  assert.equal(
    index,
    "- deepseek-ai/DeepSeek-V3 (worker, 128k context, $0.13/$0.4 per 1M in/out) via nebius",
  );
  // The budget is a running cost: every synthesize call of every mission pays for the
  // whole list, so a directory that grows one reasonable model at a time is the failure.
  assert.ok(index.length < MODEL_CARD_INDEX_BUDGET);
});

test("an empty card list renders to nothing, so the prompt can omit the section", () => {
  assert.equal(modelCardIndex([]), "");
});

test("cost is the two rates against the two kinds", () => {
  const parsed = parseModelCards(JSON.stringify([card()]));
  assert.ok(parsed.ok);
  const [entry] = parsed.cards;
  assert.ok(entry);

  // 2M in at $0.13 and 1M out at $0.40.
  assert.equal(costOf(entry, { input: 2_000_000, output: 1_000_000 }), 0.66);
});
