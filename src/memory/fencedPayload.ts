// The shape both kinds of procedural memory are stored in: prose a human reads, and one
// fenced ```json block that is what actually gets parsed (§6).
//
// A saved mission and a saved profile made the same three decisions independently —
// find the fence, parse it, validate it, and report every schema issue at once with the
// command that repairs the file — and kept two copies of each. The copies are the
// problem, not the length: `parseProfile` and `parseSavedMission` differed only in the
// schema they handed to `safeParse`, so a correction to one error message left the other
// wrong, and no test could see the difference because each file's suite only ever read
// its own half.
//
// The same argument covers the name check. Both files write a name a human typed
// straight into a filesystem path, so a name containing `..` or a separator is a way out
// of the state directory — one defence, one place, and the `kind` is only what the
// message calls the thing being named.
import path from "node:path";
import { type ZodType } from "zod";

const FENCE = "```json";

export type FencedPayloadResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * Read the one fenced ```json block out of a markdown memory file and validate it.
 *
 * `fix` is the caller's repair instruction — the command that re-creates this particular
 * file — and it is appended to every failure, because a human meeting "not valid JSON"
 * over a file they were invited to hand-edit needs to be told what to run, not what went
 * wrong. Every schema issue is reported together for the same reason: fixing one field
 * only to be shown the next is three round trips through a text editor.
 */
export function parseFencedPayload<T>(
  markdown: string,
  schema: ZodType<T>,
  fix: string,
): FencedPayloadResult<T> {
  const start = markdown.indexOf(FENCE);
  const end = start === -1 ? -1 : markdown.indexOf("```", start + FENCE.length);
  if (start === -1 || end === -1) {
    return { ok: false, problem: `no fenced \`\`\`json payload block. ${fix}` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(markdown.slice(start + FENCE.length, end));
  } catch (error) {
    return {
      ok: false,
      problem: `the \`\`\`json payload block is not valid JSON (${(error as Error).message}). ${fix}`,
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `${problems}. ${fix}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Refuse a name that is a path. `kind` names the thing in the message ("profile name",
 * "saved-mission name") and `example` is a name that would have worked, because an error
 * that only says what is wrong leaves the human guessing at the rule.
 */
export function assertPlainName(name: string, kind: string, example: string): void {
  if (name === "" || name.includes("..") || /[/\\]/.test(name) || name.includes(path.sep)) {
    throw new Error(`Refusing '${name}': not a ${kind}. Use a plain name like '${example}'.`);
  }
}
