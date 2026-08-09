// Semantic memory: facts about *this environment* that stay true across missions (§6).
//
// The tier that makes the system get better at your environment rather than starting
// from zero every Monday — and the one that can quietly ruin every future plan, since
// a wrong fact here does not fail loudly. §6's three rules are therefore enforced in
// this file rather than trusted to a prompt: everything carries provenance or it is
// refused at write time, everything stales by type, and everything is plain markdown
// a human can read, grep, and delete.
//
// That last rule is why a file that no longer parses is a warning and never an error.
// A human editing a fact by hand is the feature, so a half-finished edit must cost one
// skipped fact and not the mission. It is the one place the §9.1 "losing state must be
// loud" rule is deliberately inverted, because this state is a cache with provenance
// rather than a source of truth.
//
// Deduplication is by claim rather than by id: the same observation rediscovered on a
// later mission is the same fact, and a store that accumulates one file per rediscovery
// is a store whose staling clock resets itself every time it is consulted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FILE_MODE, ensurePrivateDir } from "../config/hygiene.js";

export const loreTypeSchema = z.enum(["observation", "research", "decision", "principle"]);

export const loreEntrySchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  type: loreTypeSchema,
  confidence: z.enum(["high", "medium", "low"]),
  // Required, and checked again at write time. A fact with no source is a rumour (§6).
  source: z.object({
    missionId: z.string().min(1),
    evidence: z.string().min(1),
    kind: z.string().min(1),
  }),
  observedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO 8601 timestamp",
  }),
  // Overrides the per-type default. Ignored for `principle`, which never stales.
  staleAfterDays: z.number().positive().optional(),
});

export type LoreType = z.infer<typeof loreTypeSchema>;
export type LoreEntry = z.infer<typeof loreEntrySchema>;

/** Guild's policy, adopted as the default (§6). `principle` is human-authored and
 *  never expires; the rest are re-verified rather than deleted. */
export const STALE_AFTER_DAYS: Record<LoreType, number | undefined> = {
  observation: 30,
  research: 30,
  decision: 180,
  principle: undefined,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FENCE = "---";

// Header values are single-line by construction: the claim is the body precisely so
// it can hold prose, and everything in the header is a short scalar.
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** One fact per file: a key/value header a human can scan and the claim as body. */
export function renderLore(entry: LoreEntry): string {
  const header = [
    `id: ${oneLine(entry.id)}`,
    `type: ${entry.type}`,
    `confidence: ${entry.confidence}`,
    `missionId: ${oneLine(entry.source.missionId)}`,
    `sourceKind: ${oneLine(entry.source.kind)}`,
    `evidence: ${oneLine(entry.source.evidence)}`,
    `observedAt: ${entry.observedAt}`,
    ...(entry.staleAfterDays === undefined ? [] : [`staleAfterDays: ${entry.staleAfterDays}`]),
  ];
  return [FENCE, ...header, FENCE, "", entry.claim.trim(), ""].join("\n");
}

export type ParseLoreResult =
  | { ok: true; entry: LoreEntry }
  | { ok: false; problem: string };

const FIX = "Fix or delete the file; a fact nobody can read is not memory.";

function splitDocument(markdown: string): { header: string[]; body: string } | undefined {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== FENCE) return undefined;
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return undefined;
  return { header: lines.slice(1, end), body: lines.slice(end + 1).join("\n").trim() };
}

function readHeader(lines: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

export function parseLore(markdown: string): ParseLoreResult {
  const document = splitDocument(markdown);
  if (!document) {
    return { ok: false, problem: `no '${FENCE}' header block. ${FIX}` };
  }

  const fields = readHeader(document.header);
  const days = fields["staleAfterDays"];
  const candidate = {
    id: fields["id"],
    claim: document.body,
    type: fields["type"],
    confidence: fields["confidence"],
    source: {
      missionId: fields["missionId"],
      evidence: fields["evidence"],
      kind: fields["sourceKind"],
    },
    observedAt: fields["observedAt"],
    ...(days === undefined ? {} : { staleAfterDays: Number(days) }),
  };

  const parsed = loreEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `${problems}. ${FIX}` };
  }
  return { ok: true, entry: parsed.data };
}

/** Stale does not mean deleted — it means re-verify before trusting, which is why a
 *  stale entry enters the ledger as a guess rather than a fact (§6). */
export function isStale(entry: LoreEntry, now: Date): boolean {
  if (entry.type === "principle") return false;
  const days = entry.staleAfterDays ?? STALE_AFTER_DAYS[entry.type];
  if (days === undefined) return false;
  const observed = Date.parse(entry.observedAt);
  if (Number.isNaN(observed)) return true;
  return now.getTime() - observed > days * DAY_MS;
}

/** The filename is a function of the claim alone, so rediscovering a fact overwrites
 *  nothing and adds nothing. A short slug keeps the directory greppable by eye. */
export function loreFileName(claim: string): string {
  const normalized = oneLine(claim).toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug === "" ? `${digest}.md` : `${slug}-${digest}.md`;
}

export type LoreActor = "human" | "orchestrator";

export interface WriteLoreResult {
  path: string;
  written: boolean;
  reason: "written" | "duplicate";
}

function assertWritable(entry: LoreEntry, actor: LoreActor): void {
  // Provenance is checked before the schema so the §6 refusal is what the caller
  // reads, rather than a zod path that says `min(1)` and names no fix.
  if (entry.source.missionId.trim() === "") {
    throw new Error(
      "Refusing to write lore with an empty source.missionId: a fact with no source is a rumour (§6). " +
        "Name the mission that observed it.",
    );
  }
  if (entry.source.evidence.trim() === "") {
    throw new Error(
      "Refusing to write lore with empty source.evidence: a fact with no source is a rumour (§6). " +
        "Give the file, URL, or task id it came from.",
    );
  }
  if (entry.type === "principle" && actor !== "human") {
    throw new Error(
      `Refusing to write a 'principle' as '${actor}': principles are human-authored only (§6). ` +
        "Write it as an 'observation' or 'decision', or have a human author it.",
    );
  }

  const parsed = loreEntrySchema.safeParse(entry);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Refusing to write lore: ${problems}. Correct the entry before writing it.`);
  }
}

/**
 * Atomic, owner-only, and refusing anything §6 says must not enter this tier.
 *
 * The rejections are thrown rather than returned because there is no sensible partial
 * outcome: a caller that ignored an unsourced write would be storing the rumour.
 */
export function writeLore(dir: string, entry: LoreEntry, actor: LoreActor): WriteLoreResult {
  assertWritable(entry, actor);

  ensurePrivateDir(dir);
  const file = path.join(dir, loreFileName(entry.claim));
  if (fs.existsSync(file)) return { path: file, written: false, reason: "duplicate" };

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderLore(entry), { mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
  return { path: file, written: true, reason: "written" };
}

export interface Recall {
  fresh: LoreEntry[];
  stale: LoreEntry[];
}

/**
 * Everything the store holds, partitioned by the staling clock.
 *
 * A missing directory is empty memory rather than an error — the first mission in a
 * repo has no lore, and that is the normal case rather than a broken one.
 */
export function readLore(dir: string, now: Date, onWarn?: (message: string) => void): Recall {
  if (!fs.existsSync(dir)) return { fresh: [], stale: [] };

  const fresh: LoreEntry[] = [];
  const stale: LoreEntry[] = [];

  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;

    const parsed = parseLore(fs.readFileSync(file, "utf8"));
    if (!parsed.ok) {
      // Never fatal: a human editing lore by hand is the point of markdown (§6).
      onWarn?.(`Skipping lore file ${file}: ${parsed.problem}`);
      continue;
    }
    (isStale(parsed.entry, now) ? stale : fresh).push(parsed.entry);
  }

  return { fresh, stale };
}
