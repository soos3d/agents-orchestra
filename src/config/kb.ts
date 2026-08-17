// What the repository looks like, for the two calls that cannot look (PLAN-NEXT 8.1).
//
// `research` and `architect` run with **no tools** — §3's rule, and the one exception is
// `judge`. So the two calls that decide what this mission is and how it is built reason
// entirely over the prompt, and until this file existed the prompt carried no fact about
// the repository at all: an architect asked to design against `src/loop/` was guessing
// that such a directory exists. A worker does not need this — it holds a real shell in a
// worktree and can run `ls` — which is why nothing here reaches one.
//
// **It is a cache and never a source.** The index is derived from `git ls-files` and a
// couple of top-level documents, written under `<stateDir>/kb/`, and keyed by the HEAD
// sha it was built at. A mismatch rebuilds; a deleted directory rebuilds; anything that
// throws on the way — no repo, no commits, no `git` — degrades to the empty string, which
// is the same prompt every mission got before this existed. Nothing in a mission may fail
// because a cache was missing.
//
// The budget is `rosterIndex`'s and `modelCardIndex`'s, applied at the same seam and for
// the same reason: every research and architect call pays for the whole index, so a
// repository that grows one plausible directory at a time until the map costs more than
// the map is worth is a failure no reviewer catches in a diff. Overflow is *named* rather
// than dropped silently — a map that quietly loses its last rows is a model reading a
// list it was told was complete.
//
// ponytail: a file tree and two documents is the cheapest thing that is actually useful.
// If real runs show the architect still guessing, the upgrade path is exported symbols per
// file (ctags-shaped, still one text blob, still budgeted here) — never embeddings, never
// a parser, never a service.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { tryGit } from "../git/repo.js";
import { ensurePrivateDir, writeFileAtomic } from "./hygiene.js";

/** The ceiling on the rendered map, in characters. ~4 chars a token, so 3,000 is roughly
 *  750 tokens against ~8.2k for an entire `--quick --plan-only` mission. Raising it is
 *  almost always the wrong fix — `ROSTER_INDEX_BUDGET`'s note says why. */
export const KB_INDEX_BUDGET = 3000;

/** How much of one top-level document is quoted. The opening of a README states what the
 *  project is, which is the fact worth paying for; the rest is installation. */
const DOC_EXCERPT_BUDGET = 600;

/** The documents worth quoting, in preference order, and at most `MAX_DOCS` of them. Only
 *  the repository root: a doc nested three directories down is about that directory. */
const KB_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"];
const MAX_DOCS = 2;

const repoKbSchema = z.object({
  /** The HEAD sha this index was built at. A mismatch is the whole invalidation rule. */
  head: z.string().min(1),
  index: z.string(),
});

export type RepoKb = z.infer<typeof repoKbSchema>;

/** Where the cache lives. Under `<stateDir>/` so `rm -rf` on it is safe by construction —
 *  the next call rebuilds. */
export const kbFile = (stateDir: string): string => path.join(stateDir, "kb", "repo.json");

export interface KbDoc {
  name: string;
  text: string;
}

/**
 * The rendered map: one line per directory, then the opening of the top-level docs.
 *
 * Pure over the file list and the documents rather than reading the disk itself, which is
 * `verifiedModelCards`' rule: what a mission's prompt carries has to be assertable with no
 * filesystem and no git. Directories are ordered by weight — the biggest is where the work
 * usually is — and ties by name, so the same tree always renders the same string and a
 * cached index and a fresh one cannot differ over nothing.
 */
export function repoIndex(
  head: string,
  files: readonly string[],
  docs: readonly KbDoc[] = [],
): string {
  if (files.length === 0) return "";

  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const key = dir === "." ? "(repository root)" : `${dir}/`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir, count]) => `- ${dir} (${count} file${count === 1 ? "" : "s"})`);

  const header =
    `Repository map at HEAD ${head.slice(0, 7)} — ${files.length} tracked ` +
    `file${files.length === 1 ? "" : "s"}. A snapshot, not a listing you can browse.\n\n`;

  const quoted = docs
    .slice(0, MAX_DOCS)
    .map((doc) => `### ${doc.name}\n\n${excerpt(doc.text)}`)
    .join("\n\n");
  const tail = quoted === "" ? "" : `\n\n${quoted}`;

  const room = KB_INDEX_BUDGET - header.length - tail.length;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = used === 0 ? line.length : line.length + 1;
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }

  if (kept.length === lines.length) return `${header}${kept.join("\n")}${tail}`;

  // The marker has to fit *inside* the budget rather than beside it, so the last line is
  // given up to make room — a ceiling that the notice about the ceiling can breach is not
  // one.
  const marker = (n: number) => `- (${n} further director${n === 1 ? "y" : "ies"} omitted for length)`;
  while (kept.length > 0 && used + marker(lines.length - kept.length).length + 1 > room) {
    used -= (kept.pop()?.length ?? 0) + 1;
  }

  return `${header}${[...kept, marker(lines.length - kept.length)].join("\n")}${tail}`;
}

/** Cut on a line boundary and say so, `designSummary`'s rule: an excerpt that does not
 *  announce it stopped reads as a document that ended there. */
function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DOC_EXCERPT_BUDGET) return trimmed;

  const cut = trimmed.slice(0, DOC_EXCERPT_BUDGET);
  const lastBreak = cut.lastIndexOf("\n");
  const kept = lastBreak > DOC_EXCERPT_BUDGET / 2 ? cut.slice(0, lastBreak) : cut;
  return `${kept.trimEnd()}\n\n(continues)`;
}

/**
 * The cached index, or `undefined` when there is none this build can read.
 *
 * A file that does not parse is a warning and a rebuild, never a raised error —
 * `loadModelCards`' rule, for its reason: a cache is not allowed to cost a mission that
 * would otherwise run.
 */
export function readRepoKb(stateDir: string, onWarn?: (message: string) => void): RepoKb | undefined {
  const file = kbFile(stateDir);
  if (!fs.existsSync(file)) return undefined;

  try {
    const parsed = repoKbSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
    onWarn?.(`Rebuilding the repo knowledge base: ${file} is not a {head, index} object.`);
  } catch (error) {
    onWarn?.(`Rebuilding the repo knowledge base: ${file} could not be read (${(error as Error).message}).`);
  }
  return undefined;
}

/**
 * The index for this repository at its current HEAD, building and caching it if the sha
 * moved. The empty string when there is nothing to index.
 *
 * One function for `orchestra doctor` and for `orchestra run`, deliberately: a cache built
 * by one path and read by another is two chances to key it differently, and the failure is
 * silent — a mission handed the map of a commit it is not on.
 */
export async function ensureRepoKb(
  stateDir: string,
  repoRoot?: string,
  onWarn?: (message: string) => void,
): Promise<string> {
  if (!repoRoot) return "";

  try {
    // `tryGit`, because a repository with no commits has no HEAD and that is a state a
    // fresh `git init` is legitimately in rather than an error.
    const head = await tryGit(repoRoot, ["rev-parse", "HEAD"]);
    if (!head.ok || head.stdout === "") return "";

    const cached = readRepoKb(stateDir, onWarn);
    if (cached && cached.head === head.stdout) return cached.index;

    const listed = await tryGit(repoRoot, ["ls-files"]);
    if (!listed.ok) return "";

    const index = repoIndex(
      head.stdout,
      listed.stdout.split("\n").filter(Boolean),
      readDocs(repoRoot),
    );

    ensurePrivateDir(path.dirname(kbFile(stateDir)));
    writeFileAtomic(kbFile(stateDir), `${JSON.stringify({ head: head.stdout, index }, null, 2)}\n`);
    return index;
  } catch (error) {
    // Every failure here is the same answer: no map. The calls that read it are written
    // for an absent one, because that is every mission run outside a git repository.
    onWarn?.(`No repo knowledge base for ${repoRoot}: ${(error as Error).message}`);
    return "";
  }
}

function readDocs(repoRoot: string): KbDoc[] {
  const docs: KbDoc[] = [];
  for (const name of KB_DOCS) {
    if (docs.length >= MAX_DOCS) break;
    const file = path.join(repoRoot, name);
    try {
      if (fs.statSync(file).isFile()) docs.push({ name, text: fs.readFileSync(file, "utf8") });
    } catch {
      // Absent or unreadable is the ordinary case — most repositories have one of these
      // four and not all of them.
    }
  }
  return docs;
}
