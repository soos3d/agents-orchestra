// Getting a JSON object back out of something a model said.
//
// Models wrap JSON in prose and fences more often than not, and a reformat round
// trip to strip ``` is pure waste — it costs a call and teaches nothing. This is
// deliberately permissive about the wrapper and strict about nothing else: the
// schema at the boundary is what decides whether the payload is acceptable.
export function extractJsonObject(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start === -1 || end <= start ? undefined : candidate.slice(start, end + 1);
}
