// The roster: agents that are written down once instead of authored per task (§7,
// amended).
//
// §7 originally said an agent is "synthesized for THIS task at plan time, never chosen
// from a fixed roster", and the argument was that a fixed list caps the system at the
// tasks its author anticipated. That argument holds and the conclusion no longer
// follows, because it costs a full authored system prompt per task to buy something a
// one-line description already decides. Measured against this repository's own source
// material: 255 candidate roles average 267 lines of body, and a name-plus-description
// index over all of them is ~15.8k tokens — more than an entire `--quick --plan-only`
// mission spends. So the roster is deliberately small and deliberately shallow.
//
// The shape that makes it cheap is the split between what the *orchestrator* reads and
// what the *worker* reads. A synthesize call is shown index lines only — name,
// description, worker kind — and answers with a name. The 267-line body is never in
// that call's context at all: it is read from disk here, composed in `compose.ts`, and
// baked into the AgentSpec before `task_planned` is emitted. Two consequences worth
// stating, because both are load-bearing:
//
//   **The event log stays self-contained.** What reaches the log is a complete system
//   prompt, exactly as when every prompt was authored fresh, so `fold`, replay, and
//   `receipt.test.ts` are untouched by this file's existence. `basedOn` on the spec is
//   provenance, not a pointer the runtime has to resolve later.
//
//   **Editing a roster file changes future missions and no past one.** That is the
//   correct behaviour and it is not the obvious one: a mission is what its log says,
//   and this directory is not part of any log.
//
// Choosing from the roster is not mandatory and the roster is not an authority. A
// synthesized spec may still be written from scratch, and everything a spec claims —
// its transport, its tools, its lease — is validated in `loop/synthesize.ts` against
// the mission envelope whether it came from here or not. Widening is still a human
// action; nothing in this directory grants a capability.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { workerKindSchema } from "../domain/task.js";

/**
 * The per-entry description cap, enforced at parse rather than by convention.
 *
 * Every synthesize call pays for the whole index, so a description is not free prose —
 * it is a recurring cost multiplied by every task of every mission. A cap in the schema
 * is what stops the index growing by well-meaning increments until it costs more than
 * the prompts it replaced.
 */
export const DESCRIPTION_BUDGET = 160;

export const rosterMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(DESCRIPTION_BUDGET),
  worker: workerKindSchema,
  /** Capability *classes* (`fs.read`), never tool names. A hint to synthesis about the
   *  shape of the work — the envelope still decides what is granted, and an entry that
   *  suggests more than a mission allows simply gets less. */
  suggests: z.array(z.string()).default([]),
});

export type RosterMeta = z.infer<typeof rosterMetaSchema>;

export interface RosterEntry extends RosterMeta {
  /** The system prompt this role contributes, verbatim. Never shown to the
   *  orchestrator — only to the worker, via `composeSystemPrompt`. */
  readonly body: string;
}

export type ParseRosterResult =
  | { ok: true; entry: RosterEntry }
  | { ok: false; problem: string };

const FIX =
  "Fix the frontmatter, or delete the file — a roster entry needs a `---` block with " +
  "name, description, worker, and a body below it.";

/**
 * The bundled roster, resolved relative to this module rather than to a working
 * directory.
 *
 * `src/agents/` and `dist/agents/` sit at the same depth below the package root, so
 * one relative path serves both the `tsx` source run and the shipped build. Unlike a
 * user's roster directory, an absent one here is a packaging bug rather than "no
 * roster", which is why `roster.test.ts` asserts it exists.
 */
export const rosterDir = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

/** A machine's own additions and corrections, beside `lore/`, `saved/` and
 *  `profiles/` for the reason those are cross-mission: a role outlives the mission
 *  that wanted it. */
export const localRosterDir = (stateDir: string): string => path.join(stateDir, "agents");

/**
 * Frontmatter, hand-rolled and strict.
 *
 * There is no YAML dependency here and there should not be one: setup simplicity is a
 * hard constraint, and the whole grammar this needs is `key: value` on one line. Strict
 * rather than lenient because the alternative — a value silently misread — ships a
 * worker prompt nobody reviewed.
 */
function readFrontmatter(markdown: string): { fields: Record<string, string>; body: string } | undefined {
  if (!markdown.startsWith("---")) return undefined;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return undefined;

  const fields: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fields[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
  }

  return { fields, body: markdown.slice(end + 4).trim() };
}

export function parseRosterEntry(markdown: string): ParseRosterResult {
  const read = readFrontmatter(markdown);
  if (!read) return { ok: false, problem: `no \`---\` frontmatter block. ${FIX}` };

  const { suggests, ...rest } = read.fields;
  const parsed = rosterMetaSchema.safeParse({
    ...rest,
    // One line in the file, a list in the schema: a class list is short enough that a
    // YAML sequence would cost more to read than it earns.
    suggests: suggests === undefined ? [] : suggests.split(",").map((one) => one.trim()).filter(Boolean),
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `${problems}. ${FIX}` };
  }

  if (read.body === "") {
    return {
      ok: false,
      problem: `the body is empty, so this role tells a worker nothing. ${FIX}`,
    };
  }

  return { ok: true, entry: { ...parsed.data, body: read.body } };
}

/**
 * Every entry across the given directories, in name order, later directories winning.
 *
 * Shadowing by name is what lets a machine correct what shipped without editing inside
 * `node_modules`: the bundled directory is passed first and `<stateDir>/agents` second.
 *
 * An unreadable entry is skipped with a warning rather than raising, the rule
 * `loadProfiles` follows and for the same reason — a half-finished hand edit must never
 * cost a mission that would otherwise run. A missing directory is an empty roster,
 * which is the normal case for the local one.
 */
export function loadRoster(
  dirs: readonly string[],
  onWarn?: (message: string) => void,
): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;

      const parsed = parseRosterEntry(fs.readFileSync(full, "utf8"));
      if (!parsed.ok) {
        onWarn?.(`Skipping roster entry ${full}: ${parsed.problem}`);
        continue;
      }
      byName.set(parsed.entry.name, parsed.entry);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
