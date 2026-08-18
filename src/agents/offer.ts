// The seam between the roster and synthesis: what the model is shown, and what its
// answer is allowed to mean.
//
// It is a separate file from `roster.ts` because of the rule the whole loop is built
// on — anything a model *receives* belongs in a pure function a test can read, since
// the fixture harness substitutes for the transport and cannot see inside a prompt
// (`agentCalls.ts`, defects 18 and 25). `rosterIndex` is that text. It is also the one
// string in the system whose *size* is a running cost rather than a one-off, so it is
// budgeted here and asserted against the shipped roster in the colocated test.
//
// Two sources, one index. A bundled roster entry and a promoted profile (§6, §7) are
// different things on disk — one is a role and a prompt, the other a whole validated
// AgentSpec kept from work that actually happened — but a model choosing between them
// should not have to care, and paying for two lists would defeat the point.
//
// The rule that keeps that safe is narrow and worth stating plainly: **`basedOn`
// contributes a system prompt and nothing else.** A promoted profile's transport,
// tools, lease and model are not carried across by naming it. They were validated
// against the envelope of the mission that promoted them, and this mission's envelope
// may be narrower; letting them ride in on a name would be a capability grant made by
// a model, which is exactly what §7's ceiling exists to prevent. So the spec that comes
// back is the model's own answer either way, and `loop/synthesize.ts` checks it either
// way.
import { type Profile } from "../memory/profiles.js";
import { type WorkerKind } from "../domain/task.js";
import { DESCRIPTION_BUDGET, type RosterEntry } from "./roster.js";

/**
 * The ceiling on the rendered index, in characters.
 *
 * Roughly a thousand tokens, against a `--quick --plan-only` mission that spends about
 * eight thousand in total. The number is a judgment rather than a law, but it has to be
 * *a* number: the failure this prevents is a roster that grows one reasonable entry at
 * a time until the index costs more than the prompts it replaced, and no reviewer
 * catches that in a diff.
 */
export const ROSTER_INDEX_BUDGET = 4000;

/** A role synthesis may name, whatever it was on disk. */
export interface OfferedRole {
  readonly name: string;
  readonly description: string;
  readonly worker: WorkerKind;
  readonly suggests: readonly string[];
  /** The system prompt this role contributes. Never rendered into the index — this is
   *  the half the worker reads and the orchestrator does not. */
  readonly body: string;
}

/** A profile's `role` was written for a human to read and answers to no cap, so the
 *  index bounds it here. Truncated rather than dropped: a promoted agent that silently
 *  stops being offered is a worse failure than a clipped sentence. */
function fit(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= DESCRIPTION_BUDGET ? flat : `${flat.slice(0, DESCRIPTION_BUDGET - 1)}…`;
}

/**
 * Everything synthesis may choose from, profiles last so a promoted role shadows a
 * bundled one of the same name.
 *
 * That order is deliberate: a human who promotes a role they had already shipped is
 * correcting it, and the correction is the more recent statement of what the role
 * should be.
 */
export function offeredRoles(
  roster: readonly RosterEntry[],
  profiles: readonly Profile[],
): OfferedRole[] {
  const byName = new Map<string, OfferedRole>();

  for (const entry of roster) {
    byName.set(entry.name, {
      name: entry.name,
      description: fit(entry.description),
      worker: entry.worker,
      suggests: entry.suggests,
      body: entry.body,
    });
  }

  for (const profile of profiles) {
    byName.set(profile.name, {
      name: profile.name,
      description: fit(profile.spec.role),
      worker: profile.spec.worker,
      // A promoted spec holds concrete tool names, not classes, and the two are not
      // interchangeable — `suggests` is a hint about the *shape* of the work, and a
      // tool list read as one would be a grant wearing a hint's clothes.
      suggests: [],
      body: profile.spec.systemPrompt,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The text a synthesize call receives. One line per role, and never a body.
 *
 * An empty roster renders to the empty string rather than to a header with no rows,
 * for the reason `staff()` omits `profiles` when nothing has been promoted: a prompt
 * that describes a library which does not exist spends context to teach the model
 * nothing.
 */
export function rosterIndex(roles: readonly OfferedRole[]): string {
  return roles
    .map((role) => {
      const suggests = role.suggests.length > 0 ? ` [${role.suggests.join(" ")}]` : "";
      return `- ${role.name} (${role.worker})${suggests}: ${role.description}`;
    })
    .join("\n");
}

/** The role a spec's `basedOn` names, or `undefined` — which synthesis refuses rather
 *  than shipping the task-specific addendum as an entire worker prompt. */
export function resolveRole(
  roles: readonly OfferedRole[],
  name: string,
): OfferedRole | undefined {
  return roles.find((role) => role.name === name);
}

/**
 * The role's prompt, then what this particular task needs on top of it.
 *
 * The order is the point. A worker reads top-down and the role is the frame the task is
 * read inside; inverting it makes the specific instruction the preamble to a general
 * one, which is how a narrowly-scoped task ends up done broadly.
 */
export function composeSystemPrompt(body: string, addendum: string): string {
  const extra = addendum.trim();
  if (extra === "") return body.trim();
  return [body.trim(), `## This task specifically\n\n${extra}`].join("\n\n");
}
