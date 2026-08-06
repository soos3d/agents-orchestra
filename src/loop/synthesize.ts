// Turning intent into something that can run (§7).
//
// A PlannedTask is intent; a Task is intent with an agent synthesized for it. Keeping
// them apart is what lets `--plan-only` produce a full plan and an estimate with no
// AgentSpec existing anywhere — and it is why this step is separate from planning
// rather than folded into it.
//
// Fable authors the agent for each task at plan time, shaped to that task's goal. The
// envelope it draws from is declared per mission by a human and synthesis can only
// narrow it: a model that authors agents *and* grants them tools has no ceiling.
import { type PlannedTask } from "../domain/ledger.js";
import { type WorkerKind } from "../domain/task.js";
import { type EventInput } from "../events/schema.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";

export interface SynthesizeDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  now?: () => string;
}

/** Synthesizes an agent for every planned task not already on the board, and emits
 *  `task_planned` for each. Tasks that already exist are left alone: a replan revises
 *  the plan, and re-synthesizing running work would duplicate it. */
export async function synthesizeTasks(
  deps: SynthesizeDeps,
  planned: readonly PlannedTask[],
  round: number,
): Promise<number> {
  const state = deps.store.state();
  const known = new Set(state.tasks.map((task) => task.id));
  const at = (deps.now ?? (() => new Date().toISOString()))();
  let added = 0;

  for (const entry of planned) {
    if (known.has(entry.id)) continue;

    const agentSpec = await deps.calls.synthesize({
      task: entry,
      envelope: state.mission.capabilityEnvelope,
      toolCatalogue: state.mission.capabilityEnvelope.toolClasses,
    });

    deps.store.emit({
      missionId: state.mission.id,
      actor: "orchestrator",
      type: "task_planned",
      task: {
        id: entry.id,
        missionId: state.mission.id,
        goal: entry.goal,
        successCriteria: [],
        satisfies: entry.satisfies,
        motivatedBy: entry.motivatedBy,
        worker: entry.worker,
        agentSpec,
        dependsOn: entry.dependsOn,
        // A task with unmet dependencies starts `waiting`, and the scheduler — not a
        // human — is what ends that wait (§4).
        status: entry.dependsOn.length > 0 ? "waiting" : "todo",
        artifacts: [],
        verify: agentSpec.verify,
        attempts: 0,
        budget: { wallMs: entry.estimatedWallMs },
        createdAt: at,
        updatedAt: at,
        ...shapeFor(entry.worker, entry.id, round),
      },
    } as EventInput);
    added++;
  }

  return added;
}

/** The fields a Task carries because of its kind. Git belongs to `code` and nowhere
 *  else (§4), so this is where a plan's worker kind becomes a task shape.
 *
 *  `owns` starts empty and the lease is declared by the agent spec's author in a later
 *  phase; an empty lease grants nothing and blocks nothing, which is the safe default
 *  while §8's declarations are still written by hand. */
function shapeFor(worker: WorkerKind, id: string, round: number): Record<string, unknown> {
  if (worker === "code") return { branch: `orchestra/${id}-r${round}`, owns: [] };
  if (worker === "computer") return { surface: "browser", allowedDomains: [] };
  return {};
}
