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

/**
 * The JSON object in something a model said, or `undefined` if there is none.
 *
 * Candidate-and-check rather than one guess, and the reason is a defect the guess
 * shipped with. A single non-greedy fence match ends at the *first* closing ``` in the
 * message — which, when a worker's `summary` describes code and contains a fenced block
 * of its own, is a fence inside the JSON string. The extracted text is then a JSON
 * document cut in half, and the caller reports "Unterminated string in JSON" about a
 * report the worker wrote correctly. Real missions failed that way and it read as the
 * transport truncating a long message.
 *
 * So every plausible candidate is tried — each fenced block, then the raw brace span —
 * and the first that actually parses wins. Falling back to the *last* candidate when
 * none parse keeps the error message about the largest thing that looked like JSON,
 * rather than about the first fragment.
 */
export function extractJsonObject(raw: string): string | undefined {
  const candidates = [
    ...[...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)].map((match) => match[1] ?? ""),
    raw,
  ]
    .map(braceSpan)
    .filter((candidate): candidate is string => candidate !== undefined);

  return candidates.find(parses) ?? candidates.at(-1);
}

/** From the first `{` to the last `}`, which is what strips the prose around an answer. */
function braceSpan(text: string): string | undefined {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start === -1 || end <= start ? undefined : trimmed.slice(start, end + 1);
}

function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}
