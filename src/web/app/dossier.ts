// What a task's agent is, as a list of facts rather than a paragraph.
//
// A task carries a whole `AgentSpec` — the role it was written as, the transport and
// model it runs on, the tools it was granted, the lease it may write inside, where its
// output goes and how it will be verified — and until now the page showed none of it.
// The one thing it did show was `goal`, which for a synthesized task is a two-thousand
// character specification, dumped unclamped into a 20rem rail. So the panel that was
// supposed to answer "what is this agent doing" answered it with a wall of text and
// left out the agent entirely.
//
// This module is the decision half and it is pure for the reason `hud.ts` is: which
// facts are shown, in what order, and which are silently dropped is exactly the kind
// of thing that is wrong invisibly. Two rules carry over from the HUD and both are
// asserted:
//
//  - **An absent optional draws no row.** `basedOn`, `outputPath` and `worktree` are
//    absent on most tasks, and a panel of empty rows teaches the eye to skip it.
//  - **An empty capability is not an absent one.** No tools and no lease are facts
//    worth reading — a code task with an empty lease is the shape defect 23 refuses —
//    so they are drawn, and they say what the emptiness means.
import { type VerifySpec } from "../../domain/artifacts.js";
import { type Task } from "../../domain/task.js";

/** One line of the spec sheet. `values` rather than `value` because half of these are
 *  lists — tools, lease globs, allowed domains — and a list rendered as a comma string
 *  is a list nobody can scan. */
export interface Fact {
  label: string;
  values: readonly string[];
  /** Set where the content is a path, a glob, an id or a command: things that are read
   *  character by character and have to line up. */
  mono?: boolean;
}

const describeVerify = (verify: VerifySpec): string =>
  verify.kind === "command"
    ? `command: ${verify.command}${verify.cwd ? ` (in the ${verify.cwd})` : ""}`
    : verify.kind === "judge"
      ? `judge: ${verify.rubric}`
      : verify.kind === "scanner"
        ? `scanner: ${verify.scanner}`
        : `none: ${verify.reason}`;

/** Minutes, from the millisecond lease the runtime enforces. Rounded, because nobody
 *  is timing this to the second and "1800000 ms" is not a budget anybody reads. */
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/** The time out of an ISO timestamp, without parsing it. `line()` in `state.ts` does
 *  the same slice for the timeline, and the two have to agree — a `Date` here would
 *  render in the reader's zone while the timeline stays in the log's. */
const clock = (at: string): string => at.slice(11, 19);

/**
 * The agent, as a spec sheet.
 *
 * Ordered by what a person asks first: who is this, what does it run on, what may it
 * touch, and how will it be judged. The task's own provenance — because, serves,
 * after — is not here: it is about the *plan* and it already has a panel.
 */
export function agentFacts(task: Task): readonly Fact[] {
  const spec = task.agentSpec;
  const transport = spec.transport;

  const facts: (Fact | null)[] = [
    { label: "role", values: [spec.role] },
    // Provenance for the roster (§7, amended): a spec that named a role was composed
    // from a body on disk, and reading the mission back to that role is the only way
    // to tell an authored prompt from an amended one.
    spec.basedOn ? { label: "from", values: [spec.basedOn], mono: true } : null,
    { label: "worker", values: [task.worker] },
    {
      label: "transport",
      values: [transport.target ? `${transport.id} · ${transport.target}` : transport.id],
      mono: true,
    },
    // Two models can be named and they are not the same claim: the spec's is what
    // synthesis asked for, the transport's is what that adapter is pinned to. Showing
    // one when they disagree is how a mission gets read as having run on a model it
    // did not.
    {
      label: "model",
      values:
        transport.model && transport.model !== spec.model
          ? [spec.model, `transport pins ${transport.model}`]
          : [spec.model],
      mono: true,
    },
    {
      label: "tools",
      values: spec.tools.length > 0 ? spec.tools : ["none granted"],
      mono: spec.tools.length > 0,
    },
    ...leaseFacts(task),
    spec.outputPath ? { label: "writes to", values: [spec.outputPath], mono: true } : null,
    { label: "verified by", values: [describeVerify(task.verify)], mono: true },
    { label: "lease", values: [minutes(task.budget.wallMs)] },
    // Zero is drawn here, unlike a HUD counter: "0 attempts" on a task that is running
    // is the fact that it has not been dispatched yet.
    { label: "attempts", values: [String(task.attempts)] },
    // The log's own clock, sliced rather than parsed — the same treatment the timeline
    // gives a timestamp, so two panels showing the same event show the same time. A
    // task that has not been dispatched has neither, and draws neither.
    ...(task.startedAt ? [{ label: "started", values: [clock(task.startedAt)], mono: true }] : []),
    ...(task.endedAt ? [{ label: "ended", values: [clock(task.endedAt)], mono: true }] : []),
  ];

  return facts.filter((fact): fact is Fact => fact !== null);
}

/** What this worker kind may reach, which is a different question per kind. §4 gives
 *  git to `code` only and §11 gives domains to `computer` only, so neither row exists
 *  on the other's panel rather than being drawn empty. */
function leaseFacts(task: Task): readonly Fact[] {
  if (task.worker === "code") {
    return [
      { label: "branch", values: [task.branch], mono: true },
      ...(task.worktree ? [{ label: "worktree", values: [task.worktree], mono: true }] : []),
      {
        label: "owns",
        // An empty lease matches nothing rather than everything (defect 23), and a
        // dash here would read as the opposite.
        values: task.owns.length > 0 ? task.owns : ["nothing — this task can write no file"],
        mono: task.owns.length > 0,
      },
    ];
  }
  // Everything else runs in no checkout and may not change the one it stands in
  // (defect 41), which is worth saying rather than leaving as an absence.
  return [{ label: "repo", values: ["no worktree — this task may not change the repo"] }];
}

/** How far through its life the task is, in words rather than as a status enum. Used
 *  for the dossier's one line of prose, above the sheet. */
export function agentLine(task: Task): string {
  const spec = task.agentSpec;
  return `${spec.role} on ${spec.transport.id}, ${spec.model}`;
}
