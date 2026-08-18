// The tool catalogue (§7): what a capability class actually resolves to.
//
// The envelope is written in *classes* because a human reads it on the compose screen
// and has to review it in seconds — `fs.write` is reviewable, a list of forty tool
// names is not (§4.0). Something has to turn a class into the concrete tools a worker
// may hold, and until this file existed nothing did: synthesis passed the envelope's
// own class list through as if it were the catalogue, so the model was invited to pick
// tools from a list of categories and whatever it answered was checked against
// nothing.
//
// Two directions, and both are needed. `resolveClasses` is what synthesis offers the
// model; `classOf` maps its answer back so `violations()` can judge it. A tool with no
// class is not merely unclassified — it is not ours, and it is refused.
//
// What this deliberately does *not* do yet is bind the worker. The `cli` transport
// spawns a subscription CLI holding its own default toolset, so today the catalogue
// governs what synthesis may grant rather than what the subprocess can reach.
// Enforcement at the worker's own tool boundary is ACP's permission channel.
// The registry has to exist before that, and a spec asking for `Bash` under a
// read-only envelope should fail at validation now rather than at the worker.
//
// It lives beside `AVAILABLE_TRANSPORTS` for the same reason that list does: this is
// the file that would have to change to grant a new capability, so the two cannot
// drift apart.

export interface ToolClass {
  readonly id: string;
  readonly tools: readonly string[];
  /** Shown to the model alongside the tools, so a class is more than a prefix. */
  readonly summary: string;
}

export const TOOL_CATALOGUE: readonly ToolClass[] = [
  {
    id: "fs.read",
    tools: ["Read", "Glob", "Grep"],
    summary: "read files under the envelope's roots",
  },
  {
    id: "fs.write",
    tools: ["Write", "Edit"],
    summary: "create and edit files under those roots",
  },
  {
    id: "shell.run",
    tools: ["Bash"],
    summary: "run commands in the task's working directory",
  },
  {
    id: "net.read",
    tools: ["WebFetch", "WebSearch"],
    summary: "fetch pages from allowlisted hosts",
  },
];

const byClass = new Map(TOOL_CATALOGUE.map((entry) => [entry.id, entry]));
// Keyed lowercase, because the tool name arrives from whichever agent is running: Claude
// Code says `Write`, OpenCode says `write`, and the catalogue's own spelling is one of
// the two. A case-sensitive lookup made every OpenCode edit an unrecognised tool, which
// `permissions.ts` correctly turns into a question for a human — so a granted `fs.write`
// envelope still stopped on every file, and gate fatigue is what makes the gates that
// matter get tapped through (§11). No two entries differ only by case; if two ever do,
// this collapses them and the assertion below is where that shows up.
const byTool = new Map(
  TOOL_CATALOGUE.flatMap((entry) => entry.tools.map((tool) => [tool.toLowerCase(), entry.id] as const)),
);

/** Every concrete tool the given classes grant, deduplicated and in catalogue order.
 *  A class nobody has authored contributes nothing rather than failing — the envelope
 *  is the human's document, and one unrecognised line in it should narrow the grant,
 *  never widen it. */
export function resolveClasses(classes: readonly string[]): string[] {
  const granted = new Set<string>();
  for (const id of classes) {
    for (const tool of byClass.get(id)?.tools ?? []) granted.add(tool);
  }
  return [...granted];
}

/** The class a tool belongs to, or `undefined` if we do not ship it. Case-insensitive —
 *  see `byTool`. */
export const classOf = (tool: string): string | undefined => byTool.get(tool.toLowerCase());

/** What a terminal run grants when no compose screen has narrowed it (§13). Defined
 *  here rather than in the CLI so the default envelope and the catalogue that has to
 *  resolve it are one edit apart. */
export const DEFAULT_TOOL_CLASSES: readonly string[] = ["fs.read", "fs.write", "shell.run"];
