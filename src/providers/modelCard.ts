// A model as a resource with a price, a size and a proof that it answers (PLAN-NEXT 2.1).
//
// `MODELS_BY_VENDOR` in `workers/harness.ts` answers "which names may a spec use" for the
// subscription CLIs and answers *nothing* for the API-key world: `openai` is empty because
// no list of `codex` models was ever verified, and `opencode` is empty because its menu is
// the human's own account and arrives on the wire. Empty means unknown there and it will
// keep meaning unknown. This file is the other half — a model somebody actually called,
// with the tier and the rates that make a mission chargeable.
//
// **A card is evidence, not a claim.** `verifiedBy` names a probe transcript and is
// required at parse: a card that no probe has ever answered is not offered, exactly as a
// transport whose binary is missing is not offered (`workers/availability.ts`). That is why
// nothing ships in the bundled `providers/` directory — writing rates for a model this
// machine has never reached would be inventing a menu, which is the one thing this whole
// area refuses to do.
//
// The loader is `roster.ts`'s, deliberately: two directories, later winning on a name, an
// unreadable entry skipped with a warning rather than raising. One difference — a card has
// no body and no prose, so the file is JSON and holds an array rather than one entry, which
// is fewer files on disk for the same merge.
//
// **The rates price the call this orchestrator makes, and nothing else.** A worker running
// under `acp/opencode` on `deepseek-v4-flash-free` is billed on *OpenCode's* contract, not
// on the card's; pricing that dispatch from these numbers would be a confident claim about
// somebody else's invoice. `events/metrics.ts` prices what a card was actually called for
// and leaves the rest unpriced, which is the same rule `unmeasured` already encodes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The ceiling on the rendered card menu, in characters.
 *
 * `ROSTER_INDEX_BUDGET`'s argument, one menu along: every synthesize call pays for the
 * whole list, so a provider directory that grows one reasonable model at a time until it
 * costs more than the choice is worth is a failure no reviewer catches in a diff.
 */
export const MODEL_CARD_INDEX_BUDGET = 2000;

const cardTierSchema = z.enum(["frontier", "strong", "worker", "fast"]);
/** The four names `--staff plan=fast` accepts. Same enum the card schema already had. */
export const CARD_TIERS = cardTierSchema.options;
export type CardTier = z.infer<typeof cardTierSchema>;

export const modelCardSchema = z.object({
  /** Exactly the string that goes into `AgentSpec.model` — this is the id a harness is
   *  told, not a display name. */
  id: z.string().min(1),
  /** A key of `PROVIDERS` in `openaiCompatible.ts`. A card naming a provider this build
   *  has no base URL for can never be probed, and so can never be offered. */
  provider: z.string().min(1),
  access: z.enum(["subscription", "api-key", "local"]),
  tier: cardTierSchema,
  contextK: z.number().int().positive(),
  costInPer1M: z.number().nonnegative(),
  costOutPer1M: z.number().nonnegative(),
  /** Where the probe transcript lives, relative to `<stateDir>/providers/`. Required:
   *  a card whose evidence is unnamed cannot be checked, and an unchecked card is not
   *  offered. Written by `probeProviders`. */
  verifiedBy: z.string().min(1),
});

export type ModelCard = z.infer<typeof modelCardSchema>;

const FIX =
  "Fix the file or delete it — a provider file is a JSON array of model cards, each with " +
  "id, provider, access, tier, contextK, costInPer1M, costOutPer1M and verifiedBy.";

/** The bundled provider directory, resolved relative to this module so one path serves
 *  the `tsx` source run and the shipped build — `rosterDir`'s trick, and its depth. It
 *  ships empty on purpose: see the file header. */
export const providersDir = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "providers");

/** This machine's own cards, beside `agents/` and for the same reason: a model outlives
 *  the mission that wanted it. Also where `probeProviders` writes its transcripts. */
export const localProvidersDir = (stateDir: string): string => path.join(stateDir, "providers");

/**
 * Where a card's evidence lives, with the traversal guard `taskArtifactDir` carries.
 *
 * `verifiedBy` reaches here from a JSON file a human hand-edited, and an absolute path or
 * a `..` in one would let a card point its proof at any readable file on the disk — which
 * turns "verified" into "this path happens to exist".
 */
export function probePath(stateDir: string, verifiedBy: string): string {
  if (verifiedBy === "" || verifiedBy.startsWith("/") || verifiedBy.split("/").includes("..")) {
    throw new Error(
      `Refusing to resolve '${verifiedBy}' as a probe transcript: it must be a relative ` +
        `path under <stateDir>/providers/ with no '..' segments.`,
    );
  }
  return path.join(localProvidersDir(stateDir), verifiedBy);
}

export type ParseCardsResult =
  | { ok: true; cards: ModelCard[] }
  | { ok: false; problem: string };

export function parseModelCards(json: string): ParseCardsResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, problem: `not JSON (${(error as Error).message}). ${FIX}` };
  }

  const parsed = z.array(modelCardSchema).safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `${problems}. ${FIX}` };
  }

  return { ok: true, cards: parsed.data };
}

/**
 * Every card across the given directories, in id order, later directories winning.
 *
 * Shadowing by id is what lets a machine correct a shipped rate without editing inside
 * `node_modules`, and an unreadable file is skipped with a warning rather than raising —
 * `loadRoster`'s rule, for its reason: a half-finished hand edit must never cost a
 * mission that would otherwise run.
 */
export function loadModelCards(
  dirs: readonly string[],
  onWarn?: (message: string) => void,
): ModelCard[] {
  const byId = new Map<string, ModelCard>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;

      const parsed = parseModelCards(fs.readFileSync(full, "utf8"));
      if (!parsed.ok) {
        onWarn?.(`Skipping provider file ${full}: ${parsed.problem}`);
        continue;
      }
      for (const card of parsed.cards) byId.set(card.id, card);
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The cards a probe has actually answered for — the offer, narrowed by evidence.
 *
 * Pure over an existence predicate rather than reading the disk itself, for the reason
 * `availableTransports` is pure over a probe result: what a mission offers a model has to
 * be assertable with no filesystem. A card whose transcript is missing is dropped
 * silently — it was never verified, so it was never on the menu to lose.
 */
export function verifiedModelCards(
  cards: readonly ModelCard[],
  exists: (verifiedBy: string) => boolean,
): ModelCard[] {
  return cards.filter((card) => {
    try {
      return exists(card.verifiedBy);
    } catch {
      // A `verifiedBy` that `probePath` refuses is not a card with missing evidence, it
      // is a card pointing somewhere it may not. Same answer either way: not offered.
      return false;
    }
  });
}

/**
 * The cards a mission may be shown on this machine: both directories, narrowed to the
 * ones with a probe transcript on disk.
 *
 * **Every composition root calls this and nothing else** — `staffingOffer`'s argument, one
 * layer down. Loading the cards in one place and narrowing them in another is two chances
 * to wire one of them, and the failure mode is silent: a mission offered a model no probe
 * ever reached, which is the whole hazard the `verifiedBy` field exists to close.
 */
export function staffableCards(stateDir: string, onWarn?: (message: string) => void): ModelCard[] {
  const all = loadModelCards([providersDir(), localProvidersDir(stateDir)], onWarn);
  return verifiedModelCards(all, (verifiedBy) => fs.existsSync(probePath(stateDir, verifiedBy)));
}

/**
 * The text a synthesize call receives. One line per card, never more.
 *
 * The four figures are what the choice is actually made on — how strong, how much context,
 * what it costs in and out — and the id is the string that has to come back. An empty list
 * renders to the empty string so the prompt omits the section rather than describing a
 * menu with no rows (`rosterIndex`'s rule).
 *
 * `MODEL_CARD_INDEX_BUDGET` is applied here rather than asserted in a test, which is where
 * the roster's ceiling lives: the shipped roster is a fixed list a test can measure once,
 * but `localProvidersDir` is the operator's own directory and grows on their machine after
 * this build was reviewed. A ceiling nothing enforces is a ceiling that reads as enforced.
 *
 * The overflow is named rather than dropped silently — a menu that quietly loses its last
 * rows is a model choosing from a list it was told was complete, and the count is what
 * tells a human to prune the directory.
 */
export function modelCardIndex(cards: readonly ModelCard[]): string {
  const lines = cards.map(
    (card) =>
      `- ${card.id} (${card.tier}, ${card.contextK}k context, ` +
      `$${card.costInPer1M}/$${card.costOutPer1M} per 1M in/out) via ${card.provider}`,
  );

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = used === 0 ? line.length : line.length + 1;
    if (used + cost > MODEL_CARD_INDEX_BUDGET) break;
    kept.push(line);
    used += cost;
  }

  const dropped = lines.length - kept.length;
  if (dropped === 0) return kept.join("\n");
  return [...kept, `- (${dropped} further card${dropped === 1 ? "" : "s"} omitted for length)`].join("\n");
}

/**
 * What a call on this card cost, in dollars.
 *
 * Both figures are required rather than defaulted to zero: absent usage is not free usage
 * (§9.5), and a caller holding only one half has a number nobody can check. Cache is not
 * priced here — an OpenAI-compatible `usage` block does not report it, and inventing a
 * discount for tokens the API never mentioned is the same mistake as inventing a menu.
 */
export const costOf = (card: ModelCard, tokens: { input: number; output: number }): number =>
  (tokens.input / 1_000_000) * card.costInPer1M + (tokens.output / 1_000_000) * card.costOutPer1M;
