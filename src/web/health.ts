// What the page is told about the machine it is looking at (UI plan U6, extended).
//
// `doctor()` answers "is this installed and authed"; this answers the question that
// follows it and that the dashboard could not ask at all until now — *what will this
// mission actually run on, and what may I change about that?*
//
// It is a pure function over a probed config for the reason the whole `web/` split
// exists: what the server **decides** belongs above the socket where it can be asserted,
// and only the plumbing belongs in `server.ts`. The decision here is a menu, and a menu
// is exactly the kind of thing that is wrong invisibly — a harness offered on a machine
// that cannot start it is defect 21 wearing a dropdown, and the mission then fails on
// the human's own instruction rather than on a planner's guess.
//
// Two asymmetries in the frame are deliberate and both are facts about the code rather
// than choices made here. The orchestrator gets models and no harness, because
// `runViaAgentSdk` *is* the Agent SDK — there is no second implementation to offer, so
// the page states the harness instead of offering it. And `fixedModels` reports what a
// human cannot pick: `progress` runs cheap because it is called every round (§3) and
// `reformat` runs cheap because restating one JSON object is not the mission's work
// (§4.1). Leaving them out would let the panel imply one model runs everything, which
// is the sort of quiet wrongness this file exists to prevent.
import { type DiscoveredConfig } from "../config/discover.js";
import { type Check } from "../config/doctor.js";
import { PROGRESS_MODEL } from "../loop/agentCalls.js";
import { availableTransports } from "../workers/availability.js";
import { MODELS_BY_VENDOR, offeredHarnesses, offeredModels } from "../workers/harness.js";
import { REFORMAT_MODEL } from "../workers/transport.js";
import { type HealthFrame } from "./protocol.js";

/** The decision points run through the Agent SDK and nowhere else, so the orchestrator's
 *  menu is one vendor's by construction rather than by policy. Named here so the reason
 *  travels with the value: change `runViaAgentSdk` and this is the other half. */
const ORCHESTRATOR_MODELS = MODELS_BY_VENDOR.anthropic;

export function healthFrame(
  config: DiscoveredConfig,
  report: { checks: readonly Check[]; ready: boolean },
  /** The cards `orchestra doctor` has probed on this machine (`staffableCards`), passed
   *  in rather than loaded here so this stays a pure function of what it is handed —
   *  reading the disk would make the menu unassertable without one. Empty is a machine
   *  with no provider configured, which is every machine until one is. */
  cards: readonly { id: string; tier: string; provider: string }[],
): HealthFrame {
  return {
    checks: report.checks,
    ready: report.ready,
    transports: availableTransports(config),
    harnesses: offeredHarnesses(config).map((harness) => ({
      id: harness.id,
      models: offeredModels(harness.id),
      honoursModel: harness.honoursModel,
    })),
    orchestratorModels: ORCHESTRATOR_MODELS,
    orchestratorModel: config.orchestratorModel,
    modelCards: cards.map((card) => ({ id: card.id, tier: card.tier, provider: card.provider })),
    fixedModels: [
      { name: "progress", model: PROGRESS_MODEL },
      { name: "reformat", model: REFORMAT_MODEL },
    ],
  };
}
