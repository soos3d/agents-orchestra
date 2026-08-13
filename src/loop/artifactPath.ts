// Whether a declared output path is inside the directory the task was given (P2).
//
// A non-`code` worker has one legal place to write — its artifact directory — and the
// path is authored by synthesis, which is a model. So this is the check that turns
// "please write under here" into something the system enforces, and it is refused at
// synthesis rather than at dispatch, where it would cost a typed retry and a replan to
// learn the same thing (§7, the same door as an undeclared lease).
//
// Resolved, never matched. `needsShell` read a `=>` inside a quoted string as a
// redirect, `extractJsonObject` stopped at a fence inside a JSON string, and the ACP
// reader split a UTF-8 sequence across a chunk — three defects (34, 37, 38), one
// mistake: a regex or a byte offset applied to text that has structure. A path has
// structure, `..` is part of it, and `startsWith` on the raw strings would accept
// `<root>/../elsewhere` and reject a legitimate `<root>/./out.md`.
import path from "node:path";

/**
 * True when `declared` resolves to `root` itself or something under it.
 *
 * Relative declarations resolve against `root`, which is what a worker means when it
 * writes `notes.md` — the directory it was given. The separator is appended before
 * the prefix test so a sibling sharing a name prefix (`<root>-scratch`) is outside,
 * which is §8's lease lesson one directory over.
 */
export function containedIn(declared: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(resolvedRoot, declared);

  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * An arbitrary absolute directory, used only to ask `containedIn` a question about a
 * declaration that has no root yet. Nothing is ever written here — and the absolute
 * guard in `declaresLegalOutput` means no declaration can name it.
 */
const NOWHERE = path.resolve(path.sep, "orchestra-declaration-check");

/**
 * Whether a spec may declare this output path at all (P2).
 *
 * Synthesis runs long before the task does, and the directory the task will get is the
 * runtime's to decide, not the model's — the same rule as the worker prompt, where the
 * absolute path is injected rather than invented. So a declaration is legal only if it
 * is *relative* and stays inside whatever root it is later resolved against: an
 * absolute path is a spec choosing its own location, and a traversal is one leaving.
 *
 * Refused at synthesis rather than at dispatch, where it would cost a typed retry and
 * a replan to learn the same thing — the same door as an undeclared lease (§7).
 */
export const declaresLegalOutput = (declared: string): boolean =>
  declared !== "" && !path.isAbsolute(declared) && containedIn(declared, NOWHERE);
