// Procedural memory, one level below a saved mission (§6, §7).
//
// Agents are synthesized per task rather than chosen from a roster, which is what makes
// "any kind of task" real — and it means the system re-authors an `invoice-reconciler`
// from scratch every month. §7's answer is promotion: a role that recurs is kept as a
// saved profile, and the library the system accumulates is the one it actually needed
// rather than the one a registry author anticipated.
//
// Three properties, and each is a decision rather than a detail:
//
//   **Promotion is explicit.** `orchestra promote` is the only way a profile is
//   written, because §6 refuses automatic learning: a system that promotes its own
//   conclusions unreviewed will eventually convince itself of something false and act
//   on it for months. Nothing in the loop calls this file.
//
//   **A profile is a hint, never a mandate.** It reaches `synthesize` as prior art and
//   whatever comes back still runs the full envelope, transport, and lease validation
//   (§7). A saved spec that a narrower envelope no longer permits is refused exactly
//   like a fresh one, which is the only reason it is safe to keep them at all.
//
//   **It is markdown a human can read and edit**, for the reason lore is (§6). That is
//   why an unparseable file here is a skipped profile and a warning, never an error:
//   losing a hint costs a mission nothing, and a half-finished edit must not park it.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FILE_MODE, ensurePrivateDir } from "../config/hygiene.js";
import { agentSpecSchema } from "../domain/task.js";

export const profileSchema = z.object({
  name: z.string().min(1),
  /** The whole synthesized spec, verbatim — role, prompt, tools, transport, verify. */
  spec: agentSpecSchema,
  /** Provenance, for the same reason lore requires it (§6): a role with no source is
   *  a suggestion nobody can trace back to work that was actually done. */
  promotedFrom: z.object({ missionId: z.string().min(1), taskId: z.string().min(1) }),
  promotedAt: z.string().min(1),
});

export type Profile = z.infer<typeof profileSchema>;

/** Cross-mission, like lore and saved missions, so `orchestra forget` does not take a
 *  role with the mission that happened to author it. */
export const profilesDir = (stateDir: string): string => path.join(stateDir, "profiles");

const FIX =
  "Re-create it with 'orchestra promote <missionId> <taskId> --as <name>', or fix the " +
  "```json block by hand.";

const FENCE = "```json";

/** Prose for the human, one fenced block for the machine — the same split a saved
 *  mission uses, and for the same reason: a system prompt round-tripped through prose
 *  is a system prompt that eventually loses a line to a markdown renderer. */
export function renderProfile(profile: Profile): string {
  return [
    `# ${profile.name}`,
    "",
    `Promoted from task \`${profile.promotedFrom.taskId}\` of mission ` +
      `\`${profile.promotedFrom.missionId}\` at ${profile.promotedAt}.`,
    "Offered to synthesis as prior art. It is never applied unchanged, and the mission",
    "envelope still bounds whatever comes back.",
    "",
    "## Role",
    "",
    profile.spec.role,
    "",
    "## Worker and transport",
    "",
    `- worker: ${profile.spec.worker}`,
    `- transport: ${profile.spec.transport.id}${
      profile.spec.transport.target ? ` (${profile.spec.transport.target})` : ""
    }`,
    `- tools: ${profile.spec.tools.length === 0 ? "_none_" : profile.spec.tools.join(", ")}`,
    `- verify: ${profile.spec.verify.kind}`,
    "",
    "## System prompt",
    "",
    profile.spec.systemPrompt,
    "",
    "## Payload",
    "",
    "Edited by hand at your own risk — this block is what is actually offered.",
    "",
    FENCE,
    JSON.stringify(profile, null, 2),
    "```",
    "",
  ].join("\n");
}

export type ParseProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; problem: string };

export function parseProfile(markdown: string): ParseProfileResult {
  const start = markdown.indexOf(FENCE);
  const end = start === -1 ? -1 : markdown.indexOf("```", start + FENCE.length);
  if (start === -1 || end === -1) {
    return { ok: false, problem: `no fenced \`\`\`json payload block. ${FIX}` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(markdown.slice(start + FENCE.length, end));
  } catch (error) {
    return {
      ok: false,
      problem: `the \`\`\`json payload block is not valid JSON (${(error as Error).message}). ${FIX}`,
    };
  }

  const parsed = profileSchema.safeParse(payload);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `${problems}. ${FIX}` };
  }
  return { ok: true, profile: parsed.data };
}

/** The defence `saveMission` and `forgetMission` both have, for the same reason: a
 *  name a human typed reaches the filesystem, so a name that is a path is a way out of
 *  the state directory. */
function assertName(name: string): void {
  if (name === "" || name.includes("..") || /[/\\]/.test(name) || name.includes(path.sep)) {
    throw new Error(
      `Refusing '${name}': not a profile name. Use a plain name like 'invoice-reconciler'.`,
    );
  }
}

/**
 * A promoted spec, minus the environment variables it was granted (defect 42).
 *
 * The same argument `offer.ts` makes about tools and transports, one capability
 * further: those names were checked against the envelope of the mission that promoted
 * them, and this profile will be offered to missions whose envelopes are narrower,
 * older, or about something else entirely. A grant that rides across on a name is a
 * grant no human made. Dropped at the write rather than at the read so a profile on
 * disk — which a human is invited to edit — never *looks* like it carries one.
 */
const withoutEnv = (profile: Profile): Profile => {
  const { env: _granted, ...spec } = profile.spec;
  return { ...profile, spec };
};

/** Atomic and owner-only, like every other write in the system. */
export function saveProfile(stateDir: string, profile: Profile): string {
  assertName(profile.name);

  const dir = ensurePrivateDir(profilesDir(stateDir));
  const file = path.join(dir, `${profile.name}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderProfile(withoutEnv(profile)), { mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Every profile on the machine, in name order.
 *
 * A missing directory is no prior art rather than an error — the first mission has
 * none, and that is the normal case. An unreadable file is skipped with a warning for
 * the reason the header gives: these are hints, and losing one must never cost a
 * mission that would otherwise run.
 */
export function loadProfiles(stateDir: string, onWarn?: (message: string) => void): Profile[] {
  const dir = profilesDir(stateDir);
  if (!fs.existsSync(dir)) return [];

  const profiles: Profile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;

    const parsed = parseProfile(fs.readFileSync(file, "utf8"));
    if (!parsed.ok) {
      onWarn?.(`Skipping profile ${file}: ${parsed.problem}`);
      continue;
    }
    profiles.push(parsed.profile);
  }
  return profiles;
}
