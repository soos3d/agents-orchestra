// The failure mode: offering a human a way to run work that this machine cannot start.
//
// That is defect 21 — a planner staffed every task with a transport that could not
// launch, each died at dispatch, burned its retry, took a replan with it, and the mission
// escalated at the reset cap having produced nothing. A dropdown is the same defect with
// a nicer surface, and it is worse in one way: the human chose it, so the mission fails
// on their instruction.
//
// The second failure mode is quieter and it is what `allowedModels` guards: `AgentSpec.
// model` is written by a model and handed to `--model`, and nothing checked it. A name
// no vendor has fails at dispatch, after the task has been planned and staffed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedModels,
  allowedTargets,
  allowedTransports,
  builtHarnesses,
  harnessId,
  MODELS_BY_VENDOR,
  offeredHarnesses,
  offeredModels,
  parseHarnessId,
  staffingOffer,
} from "./harness.js";
import { availableTransports } from "./availability.js";

test("a machine with no agent CLI is offered nothing", () => {
  assert.deepEqual(offeredHarnesses({ agents: [] }), []);
});

test("a machine with only codex is never offered a claude harness", () => {
  const offered = offeredHarnesses({ agents: ["codex"] });

  assert.ok(offered.length > 0, "codex is a built target and should offer something");
  assert.ok(
    offered.every((harness) => harness.target === "codex"),
    `offered a harness for an absent CLI: ${offered.map((h) => h.id).join(", ")}`,
  );
});

test("every offered harness is one this build actually ships", () => {
  const built = new Set(builtHarnesses().map((harness) => harness.id));
  for (const harness of offeredHarnesses({ agents: ["claude", "codex"] })) {
    assert.ok(built.has(harness.id), `${harness.id} is offered and not built`);
  }
});

test("acp harnesses do not honour a chosen model and cli harnesses do", () => {
  const offered = offeredHarnesses({ agents: ["claude", "codex"] });
  const acp = offered.filter((harness) => harness.transport === "acp");
  const cli = offered.filter((harness) => harness.transport === "cli");

  assert.ok(acp.length > 0 && cli.length > 0, "expected both transports on a full machine");
  // The adapter picks its own model and is never told ours — a page that implied
  // otherwise would be lying about what the mission will run.
  assert.ok(acp.every((harness) => harness.honoursModel === false));
  assert.ok(cli.every((harness) => harness.honoursModel === true));
});

test("a harness id round-trips and a malformed one resolves to nothing", () => {
  assert.deepEqual(parseHarnessId(harnessId("acp", "claude")), {
    transport: "acp",
    target: "claude",
  });
  for (const bad of ["", "acp", "acp/", "/claude", "acp/claude/extra"]) {
    assert.equal(parseHarnessId(bad), undefined, `parsed a malformed id: '${bad}'`);
  }
});

test("the model menu follows the harness's vendor", () => {
  assert.deepEqual([...offeredModels("cli/claude")], [...MODELS_BY_VENDOR.anthropic]);
  // Empty is "unknown", not "none": no list of codex models has been verified, and
  // inventing one is the mistake acp/registry.ts refuses for opencode.
  assert.deepEqual([...offeredModels("cli/codex")], []);
  assert.deepEqual([...offeredModels("cli/nonesuch")], []);
});

test("a pinned model is the whole allowlist, whatever the harness", () => {
  const offered = offeredHarnesses({ agents: ["claude", "codex"] });
  assert.deepEqual(allowedModels(offered, { model: "haiku" }), ["haiku"]);
  // A human naming a model is not making a suggestion to a model.
  assert.deepEqual(allowedModels(offered, { harness: "cli/codex", model: "haiku" }), ["haiku"]);
});

test("a pinned harness narrows the allowlist to its vendor", () => {
  const offered = offeredHarnesses({ agents: ["claude", "codex"] });
  assert.deepEqual(allowedModels(offered, { harness: "cli/claude" }), [
    ...MODELS_BY_VENDOR.anthropic,
  ]);
  assert.deepEqual(allowedModels(offered, { harness: "cli/codex" }), []);
});

test("an unconstrained mission on a mixed machine constrains nothing", () => {
  // The alternative is worse than doing nothing: enforcing the Anthropic half of the
  // list would refuse every legal codex model, which is a confident wrong answer.
  const offered = offeredHarnesses({ agents: ["claude", "codex"] });
  assert.deepEqual(allowedModels(offered), []);
});

test("an unconstrained mission on a claude-only machine still refuses a name no vendor has", () => {
  const offered = offeredHarnesses({ agents: ["claude"] });
  const allowed = allowedModels(offered);

  assert.deepEqual(allowed, [...MODELS_BY_VENDOR.anthropic]);
  assert.ok(!allowed.includes("gpt-9-turbo"), "an invented model id must not pass");
});

test("a pinned harness narrows the transports and targets synthesis is offered", () => {
  const offered = offeredHarnesses({ agents: ["claude", "codex"] });

  assert.deepEqual(allowedTransports(offered, "acp/claude"), ["acp"]);
  assert.deepEqual(allowedTargets(offered, "acp/claude"), ["claude"]);
  // Absent narrows nothing.
  assert.deepEqual(allowedTargets(offered).sort(), ["claude", "codex"]);
});

test("a pinned harness that this machine cannot run offers nothing to staff with", () => {
  // The refusal has to happen somewhere; here it shows up as an empty offer, which
  // `synthesizeTasks` turns into a validation failure naming the fix rather than a
  // dispatch that spawns a binary nobody has.
  const offered = offeredHarnesses({ agents: ["codex"] });
  assert.deepEqual(allowedTransports(offered, "cli/claude"), []);
  assert.deepEqual(allowedTargets(offered, "cli/claude"), []);
});

// `staffingOffer` is what every composition root calls, and the parity assertion below
// is the reason it can be. `availableTransports` has been the authority on which
// transports a machine can start since Phase 7; deriving the same answer a second way
// is exactly how two lists drift apart, so the two are pinned to each other here rather
// than trusted to stay equal by inspection.
test("the unpinned transport offer agrees with availableTransports", () => {
  for (const agents of [[], ["claude"], ["codex"], ["claude", "codex"]]) {
    assert.deepEqual(
      staffingOffer({ agents }).transports.sort(),
      availableTransports({ agents }).sort(),
      `disagreed for agents: [${agents.join(", ")}]`,
    );
  }
});

test("staffingOffer carries the human's harness and model through to one object", () => {
  const offer = staffingOffer({ agents: ["claude", "codex"] }, {
    harness: "acp/claude",
    workerModel: "haiku",
  });

  assert.deepEqual(offer, {
    transports: ["acp"],
    targets: ["claude"],
    models: ["haiku"],
    modelCards: [],
    // Empty because this probe named no backend, which is the same answer a machine with
    // Docker closed gives — a backend is running or it is not (PLAN-NEXT 3.3).
    containment: [],
  });
});

test("staffingOffer on an unequipped machine offers nothing to staff with", () => {
  assert.deepEqual(staffingOffer({ agents: [] }), {
    transports: [],
    targets: [],
    models: [],
    modelCards: [],
    containment: [],
  });
});

// The distinction the whole card layer rests on, asserted rather than left to the
// comment: a card is a *menu* the synthesize call is shown, never an entry in the
// allowlist it is checked against. A card id is a name at some provider's API, and
// whether the harness a task was staffed with can reach that provider is a fact about
// somebody's account. Letting one into `models` would offer a Nebius DeepSeek id to
// `cli/claude` — defect 21 built back out of the fix for defect 21.
test("a verified card is offered as a menu and never widens the model allowlist", () => {
  const card = {
    id: "deepseek-ai/DeepSeek-V3",
    provider: "nebius",
    access: "api-key" as const,
    tier: "worker" as const,
    contextK: 128,
    costInPer1M: 0.13,
    costOutPer1M: 0.4,
    verifiedBy: "probes/nebius-v3.json",
  };

  const offer = staffingOffer({ agents: ["claude"] }, {}, [card]);

  assert.deepEqual(offer.modelCards, [card]);
  assert.ok(!offer.models.includes(card.id));
  assert.deepEqual(offer.models, [...MODELS_BY_VENDOR.anthropic]);
});
