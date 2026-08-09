// The dashboard page, as a string.
//
// A string rather than a bundle because §2a allows one process and no build step
// beyond `tsc`: a Vite dev server or a committed React bundle both buy component
// structure the three screens here do not need, and both put a second toolchain
// between a clone and a working `orchestra run`. Phase 6's board is where that trade
// changes.
//
// The page renders from events and holds no state the log does not. It does compute a
// small projection of its own — enough to draw the sign-off screen and the inbox —
// and that is a second reducer, which is worth naming rather than hiding: `fold` runs
// on Node and imports zod, so shipping it here means the bundler this file exists to
// avoid. The containment is that the projection covers only what is *displayed*. No
// decision is taken from it; the page sends intents and the loop decides, so a
// divergence shows a stale screen and can never approve the wrong thing.
export function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fable-orchestra</title>
<style>
  :root {
    --bg: #fbfbfa; --fg: #1a1a18; --dim: #6b6b64; --line: #e0e0d8;
    --card: #ffffff; --warn: #8a5a00; --warn-bg: #fdf6e3; --accent: #1f5fa8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --fg: #e8e8e3; --dim: #9a9a92; --line: #2e2e34;
      --card: #1d1d22; --warn: #e0b354; --warn-bg: #2a2317; --accent: #7fb0e8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  h2 { font-size: .78rem; letter-spacing: .09em; text-transform: uppercase;
       color: var(--dim); margin: 1.5rem 0 .5rem; font-weight: 600; }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  .bar { display: flex; flex-wrap: wrap; gap: .4rem 1.1rem; color: var(--dim);
         font-size: .82rem; border-bottom: 1px solid var(--line); padding-bottom: .9rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
          padding: 1rem 1.15rem; margin-bottom: .7rem; }
  .warn { border-color: var(--warn); background: var(--warn-bg); }
  .crit { margin: 0 0 .7rem; }
  .crit:last-child { margin-bottom: 0; }
  .check { color: var(--dim); font-size: .84rem; word-break: break-word; }
  .id { color: var(--dim); }
  ul { margin: .2rem 0; padding-left: 1.1rem; }
  li { margin: .2rem 0; }
  button { font: inherit; padding: .45rem 1.1rem; border-radius: 6px; cursor: pointer;
           border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  input, textarea { font: inherit; width: 100%; padding: .45rem .6rem; border-radius: 6px;
                    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .row { display: flex; gap: .6rem; align-items: center; margin-top: .8rem; flex-wrap: wrap; }
  .row > input { flex: 1 1 16rem; }
  .log { max-height: 17rem; overflow-y: auto; border: 1px solid var(--line);
         border-radius: 8px; padding: .6rem .8rem; background: var(--card); }
  .log div { color: var(--dim); white-space: pre-wrap; word-break: break-word; }
  .scroll { overflow-x: auto; }
  .quiet { color: var(--dim); }
</style>
</head>
<body>
<main>
  <h1 id="goal">connecting…</h1>
  <div class="bar" id="bar"></div>
  <div id="screen"></div>
  <h2>Note — steers the mission, never blocks it</h2>
  <div class="row">
    <input id="note" placeholder="e.g. stop using the staging database">
    <button id="send-note">send</button>
    <button id="panic" title="stop dispatching now — worktrees are left intact">panic</button>
  </div>
  <h2>Timeline</h2>
  <div class="log" id="log"></div>
</main>
<script>
(() => {
  "use strict";

  // Only what the screens draw. Everything authoritative is folded on the server.
  const view = {
    goal: "", status: "", brief: "", outOfScope: [],
    criteria: [], guesses: [], plan: [], estimate: null,
    round: 0, stalls: 0, resets: 0,
    inbox: new Map(), questions: [],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function apply(event) {
    switch (event.type) {
      case "mission_created": view.goal = event.goal; break;
      case "mission_status": view.status = event.to; break;
      case "round_started": view.round = event.round; break;
      case "stall_detected": view.stalls = event.stalls; break;
      case "research_completed": view.brief = event.brief; break;
      case "ledger_revised":
        view.plan = event.ledger.plan;
        view.guesses = event.ledger.guesses;
        break;
      case "outcome_spec_written":
        view.criteria = event.criteria;
        view.guesses = event.guesses;
        view.outOfScope = event.outOfScope;
        view.estimate = event.estimate;
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
        view.inbox.set(event.questionId, { kind: "question", text: event.question });
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
      event.type === "signoff_revised" ? event.feedback : "";
    return at + "  " + event.type + (detail ? "  " + detail : "");
  }

  function renderCriteria() {
    if (!view.criteria.length) return "";
    return '<h2>Criteria</h2><div class="card">' + view.criteria.map((c) => {
      const check = c.check.kind === "command" ? "command: " + c.check.command
                  : c.check.kind === "judge" ? "judge: " + c.check.rubric
                  : "none: " + c.check.reason;
      const met = c.met === true ? " ✓" : c.met === false ? " ✗" : "";
      return '<p class="crit"><span class="id">' + esc(c.id) + '</span>  ' + esc(c.statement) + esc(met) +
             '<br><span class="check">check ▸ ' + esc(check) + '</span></p>';
    }).join("") + "</div>";
  }

  function renderSignoff() {
    const e = view.estimate;
    const cli = view.plan.filter((t) => t.worker === "code").length;

    return '<h2>Awaiting your approval</h2>' +
      (view.brief ? '<div class="card">' + esc(view.brief) + '</div>' : "") +
      renderCriteria() +
      (view.guesses.length
        ? '<h2>Guesses — these could be wrong</h2><div class="card warn"><ul>' +
          view.guesses.map((g) => "<li>" + esc(g.text) + ' <span class="quiet">(' + esc(g.confidence) + ")</span></li>").join("") +
          "</ul></div>"
        : "") +
      (view.outOfScope.length
        ? '<h2>Out of scope</h2><div class="card">' + view.outOfScope.map(esc).join("  ·  ") + "</div>"
        : "") +
      '<h2>Plan</h2><div class="card scroll"><ul>' +
        view.plan.map((t) => "<li><span class=\\"id\\">" + esc(t.id) + "</span>  [" + esc(t.worker) + "] " +
          esc(t.goal) + (t.dependsOn.length ? ' <span class="quiet">after ' + esc(t.dependsOn.join(", ")) + "</span>" : "") +
          "</li>").join("") + "</ul></div>" +
      (e ? '<h2>Estimate</h2><div class="card mono">' + e.taskCount + " tasks · ~" +
        Math.round(e.wallMs / 60000) + " min · " + e.expectedGates + " gates<br>~" +
        Math.round(e.tokens / 1000) + "k tokens measured, " + cli + " CLI runs unmeasured</div>" : "") +
      '<div class="row">' +
        '<button class="primary" id="approve">approve</button>' +
        '<input id="feedback" placeholder="or say what should change…">' +
        '<button id="revise">revise</button>' +
      "</div>";
  }

  function renderIntake() {
    return '<h2>A few questions before this is planned</h2>' +
      view.questions.map((q, i) =>
        '<div class="card"><p>' + (i + 1) + ". " + esc(q.question) + "</p>" +
        (q.options ? '<p class="quiet">' + q.options.map(esc).join("  /  ") + "</p>" : "") +
        '<input class="answer" data-qid="' + esc(q.id) + '" placeholder="leave blank to skip"></div>').join("") +
      '<div class="row"><button class="primary" id="send-intake">send answers</button></div>';
  }

  function renderInbox() {
    const items = [...view.inbox.values()].filter((i) => i.kind !== "intake");
    if (!items.length) return "";
    return "<h2>Inbox</h2>" + items.map((i) =>
      '<div class="card warn"><strong>' + esc(i.kind) + "</strong> · " + esc(i.text) + "</div>").join("");
  }

  function render() {
    $("goal").textContent = view.goal || "fable-orchestra";
    $("bar").innerHTML = [
      "status <strong>" + esc(view.status) + "</strong>",
      "round " + view.round,
      "stalls " + view.stalls,
      "resets " + view.resets,
    ].join("</span><span>").replace(/^/, "<span>") + "</span>";

    const screen =
      view.questions.length ? renderIntake() :
      view.status === "awaiting_signoff" ? renderSignoff() :
      renderCriteria() + renderInbox();

    $("screen").innerHTML = screen;
    wire();
  }

  let socket;
  const send = (message) => socket && socket.readyState === 1 && socket.send(JSON.stringify(message));

  function wire() {
    const approve = $("approve");
    if (approve) {
      approve.onclick = () => { approve.disabled = true; send({ kind: "approve" }); };
      $("revise").onclick = () => {
        const feedback = $("feedback").value.trim();
        if (feedback) send({ kind: "revise", feedback: feedback });
      };
    }

    const intake = $("send-intake");
    if (intake) {
      intake.onclick = () => {
        intake.disabled = true;
        send({
          kind: "intake",
          answers: [...document.querySelectorAll(".answer")]
            .map((el) => ({ questionId: el.dataset.qid, answer: el.value.trim() }))
            .filter((a) => a.answer !== ""),
        });
      };
    }
  }

  // Outside render(), because these controls are never redrawn — a note composer that
  // lost what you were typing every time an event arrived would be unusable in
  // exactly the long run it exists for.
  $("send-note").onclick = () => {
    const text = $("note").value.trim();
    if (!text) return;
    send({ kind: "note", scope: "global", text: text });
    $("note").value = "";
  };

  // Deliberately confirmed and deliberately not styled as the primary action. Panic
  // is not pause: it stops dispatch immediately rather than draining.
  $("panic").onclick = () => {
    if (confirm("Stop dispatching now? Worktrees and branches are left intact.")) {
      send({ kind: "panic", reason: "panic from the dashboard" });
    }
  };

  function connect() {
    socket = new WebSocket("ws://" + location.host);

    socket.onmessage = (frame) => {
      const message = JSON.parse(frame.data);
      if (message.kind === "rejected") { console.warn("rejected:", message.problem); return; }
      if (message.kind !== "events") return;

      const log = $("log");
      for (const event of message.events) {
        apply(event);
        const div = document.createElement("div");
        div.textContent = line(event);
        log.appendChild(div);
      }
      log.scrollTop = log.scrollHeight;
      render();
    };

    // The mission outlives the tab and the tab may outlive a restart. Reconnecting
    // replays from seq 0, so a reconnect and a first connect draw the same screen.
    socket.onclose = () => setTimeout(connect, 1000);
  }

  connect();
})();
</script>
</body>
</html>`;
}
