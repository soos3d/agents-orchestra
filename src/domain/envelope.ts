// The capability envelope: the ceiling on what a synthesized agent may do (§7).
//
// This is the security boundary of the whole system. A model authors agents and
// requests their tools, so the ceiling cannot live in a prompt — `contains()` runs
// at synthesis time and a request outside the envelope fails validation rather
// than being silently granted or silently dropped.
import path from "node:path";
import { z } from "zod";
import { budgetSchema } from "./budget.js";

// Tool *classes*, not tool names. The envelope is read by a human on the compose
// screen and has to be reviewable in seconds; a list of forty tool names is not.
export const envelopeSchema = z.object({
  toolClasses: z.array(z.string().min(1)),
  // Exact hosts. A domain allowlist that accepts patterns eventually contains one
  // too broad to mean anything, approved by a human who read it as specific.
  domains: z.array(z.string().min(1)),
  fsRoots: z.array(z.string().min(1)),
  // Environment variable *names*, never values (defect 42). The envelope governs what a
  // worker may do; without this it governed nothing about what a worker may read, and
  // both spawn paths handed every child the whole of `process.env` — so a `research`
  // task that needs no credential inherited every one the orchestrator was started with.
  // `.default([])` rather than `.optional()`: the envelope is embedded in
  // `mission_created`, so every log written before this field existed has to keep
  // folding, and "granted nothing" is the honest reading of a mission that never said.
  env: z.array(z.string().min(1)).default([]),
  network: z.enum(["none", "allowlist"]),
  maxSpend: budgetSchema,
  // "This mission's gates never leave this machine" is a blast-radius property and
  // belongs next to the rest of them (§17).
  approval: z.enum(["local", "local+mirror"]),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export interface CapabilityRequest {
  toolClasses?: string[];
  domains?: string[];
  fsPaths?: string[];
  /** Variable names a spec asked to be given. Names only — a value here would put a
   *  secret in the event log, which is the failure this field exists to prevent. */
  env?: string[];
  network?: Envelope["network"];
}

export interface EnvelopeViolation {
  field: "toolClasses" | "domains" | "fsPaths" | "env" | "network";
  requested: string;
}

const wildcarded = (host: string) => host.includes("*");

function outsideRoots(target: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(target);
  return !roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

// Set containment on tool classes, exact match on hosts, path prefix on roots.
// Returns every violation rather than the first, so the question that reaches the
// human (§9.4) names the whole gap instead of one item at a time.
export function violations(
  envelope: Envelope,
  request: CapabilityRequest,
): readonly EnvelopeViolation[] {
  const allowedClasses = new Set(envelope.toolClasses);
  const allowedHosts = new Set(envelope.domains);
  const allowedVars = new Set(envelope.env);

  return [
    ...(request.toolClasses ?? [])
      .filter((cls) => !allowedClasses.has(cls))
      .map((requested) => ({ field: "toolClasses" as const, requested })),
    ...(request.domains ?? [])
      // A wildcard in a *request* can never be satisfied by an exact allowlist, and
      // reporting it as an ordinary miss would read as a typo rather than a probe.
      .filter((host) => wildcarded(host) || !allowedHosts.has(host))
      .map((requested) => ({ field: "domains" as const, requested })),
    ...(request.fsPaths ?? [])
      .filter((target) => outsideRoots(target, envelope.fsRoots))
      .map((requested) => ({ field: "fsPaths" as const, requested })),
    // Set containment on names, exactly like tool classes: a variable the envelope
    // never named is a widening request whatever it happens to be called, and whether
    // or not this machine's environment has it.
    ...(request.env ?? [])
      .filter((name) => !allowedVars.has(name))
      .map((requested) => ({ field: "env" as const, requested })),
    ...(request.network === "allowlist" && envelope.network === "none"
      ? [{ field: "network" as const, requested: "allowlist" }]
      : []),
  ];
}

export function contains(envelope: Envelope, request: CapabilityRequest): boolean {
  return violations(envelope, request).length === 0;
}

export function describeViolations(found: readonly EnvelopeViolation[]): string {
  return found.map((v) => `${v.field}: ${v.requested}`).join(", ");
}
