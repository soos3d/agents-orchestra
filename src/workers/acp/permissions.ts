// What a live agent may do mid-run, decided in code rather than in a prompt.
//
// ACP gives us a real permission channel, which is what replaces the blanket
// `--dangerously-skip-permissions` the CLI transport lives with today (§12, defect 14).
// The channel is plumbing; this is the decision it carries, and it is pure and fully
// tested because it is the only thing standing between a synthesized agent and a
// capability no human granted it. A gate that runs inside the message handler is a gate
// nothing can assert (§11's argument, one process boundary in).
//
// Nothing here reads the mission's `Envelope` directly, and that is deliberate: the
// envelope was already applied at synthesis, where a spec asking for a capability
// outside it is refused and surfaces as a question (§7). By the time a worker is
// running, `AgentSpec.tools` *is* the grant, and this file's job is to hold that line
// rather than to re-derive it from state a running worker cannot see.
//
// **There is no `'deny'`, and its absence is the design.** §7 reserves widening for a
// human, and every "no" in this system is a person's: an envelope violation parks the
// mission and asks (Phase 4), a gate denial is a human's answer recorded as a dead end
// (§9.4), and `credential`-class actions are handed to the human rather than refused
// on their behalf (§11). A refusal invented here would be a decision taken away from
// them — the mission would fail without them ever hearing that a narrow grant was the
// reason. When §11's action classifier lands a class that genuinely is refused in code
// with no human in the loop, this union grows a third member and this paragraph is the
// thing to argue with. Until then a value nothing returns is a branch nothing tests.
import { type AgentSpec } from "../../domain/task.js";
import { classOf, resolveClasses } from "../toolCatalogue.js";

/** `allow` runs it; `ask` puts it in the one inbox (§10) and the task waits. */
export type PermissionDecision = "allow" | "ask";

export interface PermissionRequest {
  /** The tool name as the agent asked for it — a catalogue name, or anything else. */
  tool: string;
  /** What it wants to do with it, for the human who may have to read this. */
  detail: string;
}

/**
 * Whether a running agent's tool call is already covered by its grant.
 *
 * Two ways to be covered, and the second is the one worth explaining. A name in
 * `spec.tools` is obviously granted. A *sibling* of a class the spec demonstrably
 * holds is granted too, because the unit of approval is the class, not the name: the
 * envelope is written in classes so a human can review it in seconds (§4.0), and the
 * names on the spec are synthesis narrowing that class for one task. An agent holding
 * `Read` holds `fs.read` over the envelope's roots, so asking about `Glob` gates a
 * capability the human already approved — which is gate fatigue spent on nothing, and
 * gate fatigue is what makes the gates that matter get tapped through (§11).
 *
 * Everything else asks. A different class is a different capability and nothing here
 * may widen it; a tool the catalogue does not ship is not ours, and it asks rather
 * than refusing, for the reason in the header.
 */
export function decidePermission(spec: AgentSpec, request: PermissionRequest): PermissionDecision {
  const wanted = classOf(request.tool);
  if (wanted === undefined) return "ask";

  // The by-name case needs no branch of its own: a tool the catalogue ships is in its
  // own class's tool list, so a spec holding it holds a sibling by definition. A class
  // the catalogue declares with no tools (§7's Phase 8 placeholders) has no siblings to
  // hold, which is correct — it grants no capability at all.
  const granted = new Set(spec.tools);
  return resolveClasses([wanted]).some((tool) => granted.has(tool)) ? "allow" : "ask";
}
