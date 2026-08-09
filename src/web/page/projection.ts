// The page's own fold — the second reducer, contained.
//
// The page renders from events and holds no state the log does not; it computes a
// small projection because shipping `fold` here would mean shipping zod, which means
// the bundler this page exists to avoid. The containment is the same one
// `shell.html.ts` has stated since Phase 3: the projection covers only what is
// *displayed*. No decision is taken from it — the page sends intents and the loop
// decides, so a divergence shows a stale screen and can never approve the wrong
// thing. Keep every `case` below one-liner small; review is the only net under this
// file, exactly as it is under `agentCalls.ts`.
//
// This is a fragment of client-side JavaScript in a string. No backticks and no
// dollar-brace in the client code, so the TypeScript template literal that carries it
// stays inert.
export const pageProjection = `
  // Only what the screens draw. Everything authoritative is folded on the server.
  // "missions" is null on a per-run server and a listing under orchestra serve;
  // "watching" is which mission this tab is streaming. Everything else is one
  // mission's state and resets when the stream does — a reconnect replays from seq
  // 0, and applying a replay on top of a stale view would double every count.
  const view = { missions: null, missionsJson: "", watching: null };

  function resetMission() {
    Object.assign(view, {
      goal: "", status: "", brief: "", outOfScope: [],
      criteria: [], guesses: [], plan: [], estimate: null,
      round: 0, stalls: 0, resets: 0, paused: false,
      inbox: new Map(), questions: [],
      tasks: new Map(),
      artifacts: [],
      ledger: null,
      selected: null,
    });
  }
  resetMission();

  function apply(event) {
    switch (event.type) {
      case "mission_created": view.goal = event.goal; break;
      case "mission_status": view.status = event.to; break;
      case "round_started": view.round = event.round; break;
      case "stall_detected": view.stalls = event.stalls; break;
      case "replan_started": view.resets = event.resets; view.stalls = 0; break;
      case "pause_requested": view.paused = true; break;
      case "pause_lifted": view.paused = false; break;
      case "research_completed": view.brief = event.brief; break;
      case "ledger_revised":
        view.ledger = event.ledger;
        view.plan = event.ledger.plan;
        view.guesses = event.ledger.guesses;
        break;
      case "outcome_spec_written":
        view.criteria = event.criteria;
        view.guesses = event.guesses;
        view.outOfScope = event.outOfScope;
        view.estimate = event.estimate;
        break;
      case "criterion_checked":
        view.criteria = view.criteria.map((c) =>
          c.id === event.criterionId ? Object.assign({}, c, { met: event.met }) : c);
        break;
      case "task_planned": view.tasks.set(event.task.id, event.task); break;
      case "task_status": {
        const task = view.tasks.get(event.taskId);
        if (task) view.tasks.set(event.taskId, Object.assign({}, task, { status: event.to },
          event.to === "running" ? { startedAt: event.at } : {}));
        break;
      }
      case "artifact_written":
        view.artifacts.push({ taskId: event.taskId, artifact: event.artifact });
        break;
      case "intake_question":
        view.inbox.set(event.questionId, { kind: "intake", text: event.question });
        view.questions.push({ id: event.questionId, question: event.question, options: event.options });
        break;
      case "intake_answered":
        view.inbox.delete(event.questionId);
        view.questions = view.questions.filter((q) => q.id !== event.questionId);
        break;
      case "question_asked":
        view.inbox.set(event.questionId, { kind: "question", text: event.question, id: event.questionId });
        break;
      case "question_answered": view.inbox.delete(event.questionId); break;
      case "gate_requested":
        view.inbox.set(event.gateId, { kind: "gate", text: event.description });
        break;
      case "gate_resolved": view.inbox.delete(event.gateId); break;
    }
  }

  function line(event) {
    const at = String(event.at).slice(11, 19);
    const detail =
      event.type === "mission_status" ? event.to :
      event.type === "task_status" ? event.taskId + " → " + event.to :
      event.type === "progress_ledger" ? "progressing " + (event.ledger.isProgressBeingMade ? "✓" : "✗") +
        "  inLoop " + (event.ledger.isInLoop ? "✓" : "✗") :
      event.type === "replan_started" ? event.reason :
      event.type === "signoff_revised" ? event.feedback : "";
    return at + "  " + event.type + (detail ? "  " + detail : "");
  }
`;
