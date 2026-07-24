#!/usr/bin/env node
// Entry point: `npm run dev -- "your goal here"`
import { orchestrate } from "./orchestrator.js";

const goal = process.argv.slice(2).join(" ").trim();
if (!goal) {
  console.error('Usage: orchestra "high-level goal for the agent team"');
  process.exit(1);
}

orchestrate(goal).catch((err) => {
  console.error("Orchestrator crashed:", err);
  process.exit(1);
});
