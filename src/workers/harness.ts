// What a human picks when they pick "how the workers run" — one name for a pair that
// was never independent (§7, UI plan).
//
// A worker's runtime is two fields on its spec: `transport.id` (`cli` or `acp`) and
// `transport.target` (`claude`, `codex` or `opencode`). They read like two choices and
// they are not: `acp/codex` is a different thing from `cli/codex` in exactly one way a
// person cares about, and `cli/opencode` does not exist however plausible the
// cross-product looks. So the pair is named once, as `<transport>/<target>`, which is the
// vocabulary the project already used in prose before it existed in code — five real
// missions "ran over `acp/claude`".
//
// Everything here is a pure function over what `discoverConfig` probed, for the reason
// `availability.ts` is: what a machine is *offered* has to be assertable with no PATH, no
// subprocess and no model. Offering a harness this machine cannot start is defect 21, and
// offering it in a browser dropdown is the same defect wearing a nicer coat.
//
// **Two facts here are load-bearing and neither is guessable from the design.**
//
// The first is that whether `AgentSpec.model` reaches an ACP agent is *per agent*, and
// only a capture can say. `acp/claude` is never told our model: nothing is sent in
// `session/new`, the adapter picks its own, and `models.currentModelId` is the only place
// the client learns which — in the captured session a task specced `claude-sonnet-4-5`
// ran on `claude-opus-4-6`. `acp/opencode` is the opposite: `session/set_model` is
// accepted for a model it has and refused `-32602` for one it does not, before the prompt
// and before any spend. So `honoursModel` is read off the launch row
// (`AcpLaunch.honoursModel`) rather than derived from the transport id, and a page says
// which control is real. The figure that is true either way is `spend_recorded.model`,
// which records what ran.
//
// The second is why `openai` has an empty model list. There is no probe for "which models
// does this CLI accept" and `codex --model` takes whatever it is given, so a list here
// would be invented. An empty list means *unknown*, never *none*: nothing is offered as a
// menu and nothing is refused at validation. Absent stays absent, exactly as it does for
// token usage (§9.5). `opencode` is empty for a neighbouring reason — its menu is the
// human's account, and it arrives on the wire.
import { type ModelCard } from "../providers/modelCard.js";
import { acpAgentCommand, acpTargets } from "./acp/registry.js";
import { availableContainment, type ProbedAgents } from "./availability.js";
import { AVAILABLE_TRANSPORTS, CLI_TARGETS } from "./transport.js";

export type Vendor = "anthropic" | "openai" | "opencode" | "pi";

/** Who makes the models a target runs, which is what decides the model menu. A target
 *  with no entry has no vendor and is not offered — the same refusal `acpAgentCommand`
 *  makes for a launch it has not captured. */
const VENDOR_OF_TARGET: Readonly<Record<string, Vendor>> = {
  claude: "anthropic",
  codex: "openai",
  // Not a model maker: OpenCode is a gateway, and the models it can reach are whatever
  // the human's own account and config offer. That is why it is its own vendor rather
  // than being filed under one of the others — see `MODELS_BY_VENDOR`.
  opencode: "opencode",
  // A gateway too, and for a sharper version of OpenCode's reason: pi ships with no provider
  // at all, so its menu is not merely account-shaped, it is empty until a human logs one in.
  pi: "pi",
};

/**
 * The model names offered per vendor.
 *
 * Aliases rather than pinned ids, for the reason `discoverConfig` defaults
 * `orchestratorModel` to `"opus"`: an alias follows whatever the SDK and the CLI resolve
 * it to, so this list ages slowly and nothing in the design depends on a specific model
 * (§14). These three are already the vocabulary of the codebase — `ORCHESTRATOR_MODEL`,
 * `PROGRESS_MODEL`, `REFORMAT_MODEL`.
 *
 * `openai` is empty and that is the honest answer, not a gap to be filled: see the file
 * header. An empty list is read everywhere as "unknown", so a `codex` worker runs on
 * whatever its own CLI is configured for and a spec naming a model is neither offered
 * nor refused.
 */
export const MODELS_BY_VENDOR: Readonly<Record<Vendor, readonly string[]>> = {
  anthropic: ["opus", "sonnet", "haiku"],
  openai: [],
  // Empty for a *different* reason than `openai`, and the difference is worth naming.
  // There is no list to write down: OpenCode's menu is whatever the human's account and
  // config resolve to, it arrives on the wire in `session/new`'s `configOptions`, and it
  // differed between two machines in the capture notes. Empty is "unknown" here as
  // everywhere — nothing offered, nothing refused — and the refusal that matters happens
  // at the agent: `session/set_model` rejects a model it does not have, before the
  // prompt. Stage 2's model cards are what fills this in with something verified.
  opencode: [],
  // Empty, and the capture is what made that the answer rather than a shrug: on a machine with
  // no provider logged in, `pi --list-models` lists nothing at all, and on one with a provider it
  // lists whatever that account resolves to. So there is no list to write down here either — and
  // pi has *less* of one than OpenCode, since it does not even ship a default. Unknown, so
  // nothing offered and nothing refused; the refusal that would matter does not exist on this
  // target, because pi answers an invented `--model` with a warning and runs the turn anyway
  // (`src/testing/cli-transcripts/README.md`).
  pi: [],
};

/** A way work can run, named once. `id` is what a message carries and a page renders;
 *  the two halves are what a `TransportRef` is built from. */
export interface Harness {
  readonly id: string;
  readonly transport: string;
  readonly target: string;
  readonly vendor: Vendor;
  /** Whether a model chosen for this harness actually reaches the agent. False on `acp`:
   *  the adapter picks its own and is never told ours. See the file header. */
  readonly honoursModel: boolean;
}

export const HARNESS_SEPARATOR = "/";

export const harnessId = (transport: string, target: string): string =>
  `${transport}${HARNESS_SEPARATOR}${target}`;

/** Splits an id back into its halves, or `undefined` for anything that is not one.
 *  Deliberately strict about the shape rather than lenient: this parses a string that
 *  arrived from a browser, and a near-miss must fail rather than resolve to half a pair. */
export function parseHarnessId(id: string): { transport: string; target: string } | undefined {
  const parts = id.split(HARNESS_SEPARATOR);
  if (parts.length !== 2) return undefined;
  const [transport, target] = parts;
  if (!transport || !target) return undefined;
  return { transport, target };
}

/** Every harness this *build* ships, before any machine is consulted — the harness
 *  analogue of `AVAILABLE_TRANSPORTS`, and separate from `offeredHarnesses` for the same
 *  reason that constant is separate from `availableTransports()`. */
export function builtHarnesses(): Harness[] {
  return AVAILABLE_TRANSPORTS.flatMap((transport) => {
    const targets = transport === "acp" ? acpTargets() : CLI_TARGETS;
    return targets.flatMap((target): Harness[] => {
      const vendor = VENDOR_OF_TARGET[target];
      if (vendor === undefined) return [];
      return [
        {
          id: harnessId(transport, target),
          transport,
          target,
          vendor,
          // Per target, from the row that launches it — `acp/claude` is never told our
          // model and `acp/opencode` refuses one it does not have. A rule keyed on the
          // transport alone was true only while every ACP adapter behaved the same way.
          honoursModel: transport === "acp" ? acpAgentCommand(target)?.honoursModel === true : true,
        },
      ];
    });
  });
}

/**
 * The harnesses to offer on *this* machine: a built one whose underlying agent CLI is on
 * PATH.
 *
 * One rule and it is the same one `availableTransports` applies a layer up — an ACP
 * adapter is a shim over `claude` or `codex`, so both transports need the target's own
 * binary installed and authed. On a machine with neither this is empty, which is the
 * honest answer: `doctor` already fails the `workers` line for it.
 */
export function offeredHarnesses(probe: ProbedAgents): Harness[] {
  const present = new Set(probe.agents);
  return builtHarnesses().filter((harness) => present.has(harness.target));
}

/** The model names to offer for a harness id, or an empty list where nothing is known —
 *  which is also what an unrecognised id gets, since inventing a menu for a harness we
 *  cannot name the vendor of is the mistake this whole file avoids. */
export function offeredModels(id: string): readonly string[] {
  const parsed = parseHarnessId(id);
  if (!parsed) return [];
  const vendor = VENDOR_OF_TARGET[parsed.target];
  return vendor === undefined ? [] : MODELS_BY_VENDOR[vendor];
}

/**
 * The allowlist `synthesize` is validated against, given what the human chose.
 *
 * Three cases and they collapse into one rule — the list is as narrow as the human made
 * it, and empty means unconstrained:
 *
 *   - a model was pinned: exactly that one, whatever the harness thinks of it. A human
 *     naming a model is not a suggestion to a model.
 *   - a harness was pinned and no model: that vendor's menu, so a spec cannot ask a
 *     `codex` worker to run `opus`.
 *   - neither: every model any offered harness could run, which still refuses a name no
 *     vendor has — the hole this closes is `AgentSpec.model` reaching `--model` as
 *     unvalidated model output.
 *
 * Empty is *unconstrained* rather than *forbidden* everywhere it is read, because a
 * vendor with no known menu (see `MODELS_BY_VENDOR`) must not fail every task staffed
 * against it.
 */
export function allowedModels(
  offered: readonly Harness[],
  chosen: { harness?: string; model?: string } = {},
): string[] {
  if (chosen.model !== undefined) return [chosen.model];
  if (chosen.harness !== undefined) return [...offeredModels(chosen.harness)];

  const vendors = new Set(offered.map((harness) => harness.vendor));
  const known = [...vendors].flatMap((vendor) => MODELS_BY_VENDOR[vendor]);
  // A vendor with no menu makes the whole list unconstrained rather than shortening it:
  // half an allowlist would refuse every legal `codex` model to enforce the Anthropic
  // half, which is the confident wrong answer.
  return vendors.size > 0 && [...vendors].some((vendor) => MODELS_BY_VENDOR[vendor].length === 0)
    ? []
    : [...new Set(known)];
}

/**
 * Everything `synthesizeTasks` needs to know about what a spec may run on, computed in
 * one place from what the machine has and what the human chose.
 *
 * It exists as one function rather than three because of the footgun this codebase has
 * hit repeatedly: an optional field on a `Deps` interface is a place a feature can be
 * finished and switched off at once (`requestExtension`, `owns`, `reformat`, and the
 * `transports` list itself). Three separately-derived lists at four composition roots is
 * twelve chances to wire two of them; one object is one.
 *
 * Every composition root passes the result of *this*, never `AVAILABLE_TRANSPORTS` and
 * never a hand-built list.
 */
export function staffingOffer(
  probe: ProbedAgents,
  // `| undefined` on each so a folded `Mission["runtime"]` can be handed over whole,
  // rather than every caller rebuilding it field by field under
  // `exactOptionalPropertyTypes` — which is a rebuild that can drop a field silently.
  chosen: { harness?: string | undefined; workerModel?: string | undefined } = {},
  // Verified model cards (PLAN-NEXT 2.1), already narrowed to the ones a probe answered
  // for. They ride in the offer rather than in a `Deps` field of their own for this
  // function's whole reason: one object is one chance to wire it, four separately-passed
  // lists at three composition roots is twelve.
  //
  // **They are a menu the synthesize call is shown, not an allowlist it is checked
  // against**, and the difference is deliberate. `models` narrows what a spec may name;
  // a card's `id` is a name at some *provider's* API, and whether a given harness can
  // reach it is a fact about that harness's account, not about this list. Putting card
  // ids into `models` would offer a Nebius DeepSeek id to `cli/claude` — defect 21 built
  // out of the fix for defect 21. The door for a card id is the provider path
  // (PLAN-NEXT 4.2), where the card list genuinely *is* the complete menu.
  cards: readonly ModelCard[] = [],
): {
  transports: string[];
  targets: string[];
  models: string[];
  modelCards: ModelCard[];
  containment: string[];
} {
  const offered = offeredHarnesses(probe);
  return {
    transports: allowedTransports(offered, chosen.harness),
    targets: allowedTargets(offered, chosen.harness),
    // The fifth leg, here for this function's whole reason (PLAN-NEXT 3.3). It narrows
    // nothing on a mission composed without containment; on one composed with it, an
    // empty list is the difference between a refusal at validation and every task dying
    // at dispatch.
    containment: availableContainment(probe),
    ...(chosen.workerModel === undefined
      ? { models: allowedModels(offered) }
      : { models: allowedModels(offered, { model: chosen.workerModel }) }),
    modelCards: [...cards],
  };
}

/** One half of a harness row, narrowed by the harness the human pinned. Absent narrows
 *  nothing — every row the machine offers stays available.
 *
 *  Written once rather than twice because the two halves of a harness are one choice
 *  (`harness.ts`'s whole argument): two copies of this filter is two chances for a pin to
 *  narrow the transports and not the targets, which offers a pair that was never a row. */
function allowedHalf(offered: readonly Harness[], half: (entry: Harness) => string, harness?: string): string[] {
  const kept = harness === undefined ? offered : offered.filter((entry) => entry.id === harness);
  return [...new Set(kept.map(half))];
}

/** The transport ids a mission may staff with, given the harness the human pinned. */
export const allowedTransports = (offered: readonly Harness[], harness?: string): string[] =>
  allowedHalf(offered, (entry) => entry.transport, harness);

/** The same for targets, and the reason this exists at all: `SYNTHESIZE_PROMPT` used to
 *  name "claude or codex" in prose, so a machine with only `codex` installed still
 *  invited a spec targeting `claude` — defect 21's shape, one field along from the
 *  transport that had already been fixed. */
export const allowedTargets = (offered: readonly Harness[], harness?: string): string[] =>
  allowedHalf(offered, (entry) => entry.target, harness);
