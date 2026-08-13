// What a worker is told, assembled once for every transport that runs one.
//
// This lived inside the `cli` transport while `cli` was the only transport, and that
// was fine right up until it was not: ACP (Phase 7) runs the same task through a
// different runtime, and a second copy of this assembly is a second contract with the
// worker that nothing compares. The drift would not fail loudly either — a report
// instruction that lost a line produces a worker that did the work and threw it away,
// because the orchestrator never sees the transcript (§4.1). That cost defects 20
// and 24 already.
//
// So it is a pure function of the task, for the same reason `queryOptions` in
// `loop/agentCalls.ts` is one: anything a model *receives* belongs somewhere a test
// can read it, since the harness that substitutes for the transport cannot (defect 18).
import { workerReportSchema } from "../domain/report.js";
import { type Task } from "../domain/task.js";
import { renderSchema } from "../runtime/json.js";

/**
 * The whole of what a worker sees: its synthesized role, its goal, and how to finish.
 *
 * Nothing about the mission, the ledger, or the other tasks (§4, context discipline) —
 * the goal is written self-contained at plan time precisely so this can be true.
 */
export function workerPrompt(task: Task, artifactDir?: string): string {
  const { systemPrompt } = task.agentSpec;
  return [
    systemPrompt,
    `## Your task\n\n${task.goal}`,
    ...(artifactDir ? [outputInstruction(task, artifactDir)] : []),
    REPORT_INSTRUCTION,
  ].join("\n\n");
}

/**
 * Where a worker's outputs go (P2), injected by the runtime rather than invented by
 * the spec — the same rule `outputPath` is validated against at synthesis.
 *
 * It exists because a task can be obliged to leave a file (a judge grades files on
 * disk, defect 27) and forbidden to write into the checkout (defect 41), which left
 * exactly one legal location and no way for the worker to know it. The path is
 * absolute because a worker resolves paths against the directory it was given, and
 * that directory is not this one.
 */
function outputInstruction(task: Task, artifactDir: string): string {
  const declared = task.agentSpec.outputPath;
  return (
    `## Where your output goes\n\n` +
    `Write any file this task produces under \`${artifactDir}\`. That directory ` +
    `exists and is yours; nothing outside it is.` +
    (declared ? ` This task's output belongs at \`${artifactDir}/${declared}\`.` : "") +
    `\n\nReport every file you write as an artifact with its full path, or the check ` +
    `that grades this task will not be able to open it.`
  );
}

/**
 * The report is the orchestrator's entire evidence base (§4.1) — it never sees the
 * transcript — so a worker that ends its turn in prose has done the work and thrown
 * it away. Against a real model that happened on four of seven dispatches, because
 * the instruction described the shape in prose and left the model to infer which
 * fields were required and what an `Artifact` looks like.
 *
 * The schema is rendered from `workerReportSchema` rather than written out, so it
 * cannot drift from the parser that will reject the answer. The prose that survives
 * is the part a schema cannot say: that the transcript is discarded, and what the
 * `outcome` values are actually for.
 */
export const REPORT_INSTRUCTION = `## How to finish

The orchestrator never sees your transcript. Anything not in the object below is
lost — including work you did. End your turn with a single JSON object matching this
schema, and nothing after it:

${renderSchema(workerReportSchema)}

Every required field must be present; use an empty array where you have nothing.

\`outcome\` is your own verdict, not a formality. Use "completed" only if you did the
whole task, "partial" if you got some of the way, "failed" if the approach does not
work, and "blocked" if you need a human — with the question in \`summary\`.

\`deadEnds\` is what stops the next attempt walking into what you already tried, and
\`unknowns\` becomes the next round's research. A failed task that fills those in is
worth more than a silent one.`;
