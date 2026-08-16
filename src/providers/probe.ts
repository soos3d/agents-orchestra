// The verification door: a model card is offered because a probe reached it, or not at all
// (PLAN-NEXT 2.3).
//
// This is `workers/availability.ts` for models. That file exists because offering a
// transport this machine cannot start staffs every task against something that dies at
// dispatch — the planner burns a typed retry per task, takes a replan with it, and the
// mission escalates having produced nothing (defect 21). A model card is the same hazard
// one field along: `AgentSpec.model` becomes `--model` or a `session/set_model`, and a card
// whose id the provider does not recognise fails at dispatch with the task already staffed.
//
// So the probe is the *only* thing that puts a card on the menu. It runs at
// `orchestra doctor` — the command whose whole job is "what works on this machine" — calls
// each card's model for one token, and writes what came back to the path the card's
// `verifiedBy` names. `verifiedModelCards` then narrows the offer to the cards with a
// transcript on disk, which is a pure function a test can read.
//
// A failed probe writes nothing. That matters: the transcript is the evidence, so leaving a
// stale one behind after the model was withdrawn would keep offering a card that no longer
// answers. Deleting the transcript is how a human un-verifies a card by hand.
import fs from "node:fs";
import path from "node:path";
import { DIR_MODE, FILE_MODE, ensurePrivateDir } from "../config/hygiene.js";
import { type ModelCard, probePath } from "./modelCard.js";
import { type ChatDeps, PROVIDERS, chatCompletion } from "./openaiCompatible.js";

/** One token, one word. The probe answers "does this id resolve and does the key work",
 *  and nothing about the answer's content is read — a bigger prompt would spend real
 *  money on every `doctor` run to learn the same fact. */
const PROBE_PROMPT = "ping";

export type ProbeOutcome =
  | { readonly card: ModelCard; readonly ok: true; readonly ranOn?: string }
  | { readonly card: ModelCard; readonly ok: false; readonly problem: string };

export interface ProbeDeps extends ChatDeps {
  readonly stateDir: string;
  /** Key values by provider name, threaded from `discoverConfig` — `process.env` is read
   *  in two places in this codebase and this is not a third. A provider with no key is
   *  skipped rather than failed: not configuring one is a configuration, not a gap. */
  readonly keys: Readonly<Record<string, string>>;
  readonly now?: () => string;
}

/**
 * Probes every card whose provider has a key, and returns what happened to each.
 *
 * Cards with no key for their provider are absent from the result entirely rather than
 * reported as failures — the same distinction `MODELS_BY_VENDOR`'s empty lists carry.
 * Nothing was tried, so nothing is claimed.
 */
export async function probeProviders(
  deps: ProbeDeps,
  cards: readonly ModelCard[],
): Promise<ProbeOutcome[]> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const outcomes: ProbeOutcome[] = [];

  for (const card of cards) {
    const apiKey = deps.keys[card.provider];
    if (apiKey === undefined || apiKey === "" || PROVIDERS[card.provider] === undefined) continue;

    try {
      const result = await chatCompletion(
        {
          provider: card.provider,
          model: card.id,
          apiKey,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          maxTokens: 1,
        },
        deps.fetch ? { fetch: deps.fetch } : {},
      );

      writeTranscript(deps.stateDir, card, {
        at,
        provider: card.provider,
        requested: card.id,
        ...(result.ranOn === undefined ? {} : { ranOn: result.ranOn }),
        usage: result.usage,
      });

      outcomes.push({
        card,
        ok: true,
        ...(result.ranOn === undefined ? {} : { ranOn: result.ranOn }),
      });
    } catch (error) {
      outcomes.push({ card, ok: false, problem: (error as Error).message });
    }
  }

  return outcomes;
}

/** Atomic, 0600, and under a 0700 directory — the rule every other write in this codebase
 *  follows. A transcript names a provider and a model but never the key, which is why the
 *  request body is not part of it. */
function writeTranscript(stateDir: string, card: ModelCard, transcript: unknown): void {
  const file = probePath(stateDir, card.verifiedBy);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  ensurePrivateDir(path.dirname(file));

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(transcript, undefined, 2)}\n`, { mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
}
