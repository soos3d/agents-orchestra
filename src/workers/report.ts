// Turning whatever a worker actually said into a WorkerReport (§4.1).
//
// A worker returning prose instead of the schema gets one reformat attempt, then
// the task fails as a transport error (§9.4) — which means it is retried once by
// the transport policy rather than being handed to a fix task, because a worker
// that cannot produce its return type has not told us anything about the work.
import { workerReportSchema, type WorkerReport } from "../domain/report.js";
import { extractJsonObject } from "../runtime/json.js";

export class WorkerReportError extends Error {
  readonly failure = "transport" as const;
  readonly raw: string;

  constructor(message: string, raw: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerReportError";
    this.raw = raw;
  }
}

/** Asks the worker to restate its last message as the schema. Injected so the
 *  parser stays testable without a model. */
export type Reformatter = (raw: string, problem: string) => Promise<string>;

function attempt(raw: string): { report: WorkerReport } | { problem: string } {
  const json = extractJsonObject(raw);
  if (json === undefined) return { problem: "no JSON object found in the response" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { problem: `the JSON object does not parse: ${(err as Error).message}` };
  }

  const result = workerReportSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { problem: `it does not match WorkerReport — ${issues}` };
  }
  return { report: result.data };
}

/**
 * Parse a worker's final message. Exactly one reformat attempt: a second would let
 * a worker that cannot follow the schema burn the task's whole budget on retries.
 */
export async function parseWorkerReport(
  raw: string,
  options: { reformat?: Reformatter } = {},
): Promise<WorkerReport> {
  const first = attempt(raw);
  if ("report" in first) return first.report;

  if (!options.reformat) {
    throw new WorkerReportError(`Worker did not return a WorkerReport: ${first.problem}.`, raw);
  }

  const reformatted = await options.reformat(raw, first.problem);
  const second = attempt(reformatted);
  if ("report" in second) return second.report;

  throw new WorkerReportError(
    `Worker did not return a WorkerReport after one reformat attempt: ${second.problem}.`,
    raw,
  );
}
