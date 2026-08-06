// Getting a JSON object back out of something a model said, and telling it what
// shape to say in the first place.
//
// Models wrap JSON in prose and fences more often than not, and a reformat round
// trip to strip ``` is pure waste — it costs a call and teaches nothing. This is
// deliberately permissive about the wrapper and strict about nothing else: the
// schema at the boundary is what decides whether the payload is acceptable.
import { z } from "zod";

/**
 * A zod schema as the JSON Schema to put in a prompt.
 *
 * Derived rather than hand-written, so a prompt and the boundary that rejects its
 * answer cannot drift. Both sides of the system needed this independently — the
 * orchestrator's five decision points and the worker's `WorkerReport` — and both had
 * the same defect first: a prompt that said "return JSON" without saying which JSON,
 * and a model that then invented field names nobody could have guessed.
 *
 * `io: "input"` because the model is writing the parser's input, and
 * `unrepresentable: "any"` so a deliberately open field renders instead of throwing.
 */
export const renderSchema = (schema: z.ZodType<unknown>): string =>
  JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), null, 2);

export function extractJsonObject(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start === -1 || end <= start ? undefined : candidate.slice(start, end + 1);
}
