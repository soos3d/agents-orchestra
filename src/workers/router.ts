// Which runtime a task actually runs on, decided from the `TransportRef` on its spec.
//
// The registry lists transports rather than agents (§7), and until Phase 7 there was
// one of them — so `createCliTransport` answered for every id by refusing the ones it
// was not. That is the right guard in the wrong place once a second transport exists:
// the composition root would have to pick, and picking wrong means an ACP task quietly
// running through a subscription CLI, or the message about an unbuilt transport coming
// from whichever transport happened to be wired.
//
// So the id is owned here. There is exactly one place that maps an id to a runtime,
// and exactly one message for an id nobody built — naming the id, what is available,
// and the fix (§2a rule 5), because an unbuilt transport is a *planning* problem and
// the planner has to be told which ids exist in order to plan differently.
//
// It throws rather than returning a refusal on purpose: `dispatch` classifies a throw
// between `running` and the report as a `transport` failure (§9.4), which is exactly
// what this is — the worker delivered nothing — and the typed retry then the replan
// are the right response. Defect 21 is the cost of getting this wrong: every task died
// at dispatch, burned its retry, took the replan with it, and the mission escalated at
// the reset cap having produced nothing.
import { type WorkerTransport } from "../loop/dispatch.js";

/**
 * One transport that dispatches to many, keyed by `TransportRef.id`.
 *
 * The keys are plain strings rather than the `TransportRef` id union because what is
 * *built* is a shorter list than what §7 describes — the same argument that makes
 * `AVAILABLE_TRANSPORTS` a separate list from the schema's enum, and the reason an
 * unbuilt id has to be representable here at all.
 */
export function routeTransport(transports: Record<string, WorkerTransport>): WorkerTransport {
  const available = Object.keys(transports);
  if (available.length === 0) {
    throw new Error(
      "routeTransport() needs at least one transport. Wire the transports this build " +
        "ships (currently 'cli') at the composition root.",
    );
  }

  return async (input) => {
    const { id } = input.task.agentSpec.transport;
    const transport = transports[id];
    if (!transport) {
      throw new Error(
        `Transport '${id}' is not built — this build ships ${available.join(", ")}. ` +
          `Plan this task with one of those, or wire '${id}' at the composition root.`,
      );
    }
    return transport(input);
  };
}
