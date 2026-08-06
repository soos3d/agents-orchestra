// The five decision points, against a real model. The first thing in Phase 2 that
// costs money — kept behind the `Calls` interface so everything above it stays
// testable for free.
import { type DiscoveredConfig } from "../config/discover.js";
import { type Calls } from "./calls.js";

export function createAgentCalls(_config: DiscoveredConfig): Calls {
  throw new Error(
    "The model-backed decision points are not wired yet (Phase 2, step 7).\n" +
      "`orchestra run --plan-only` and the loop both work against a supplied Calls; " +
      "pass one in, or wait for the Agent SDK implementation.",
  );
}
