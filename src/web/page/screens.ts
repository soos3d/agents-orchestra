// What each screen says, as pure string-building functions over the page projection.
//
// Phase 6's additions live here: the board (§13's run view), the ledger strip, the
// provenance panel (§4.2 — the answer to "why is it doing that", which a transcript
// does not answer), and the artifact list. Artifacts render *metadata only* — kind,
// path, summary, counts. Serving file contents would put a disk-reading route on the
// approval surface, and that trade is deliberately not taken here (Phase 6 plan;
// same instinct as §17's rows about what leaves the machine).
//
// Client-side JavaScript in a string: no backticks, no dollar-brace.
export const pageScreens = `
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function renderCriteria() {
    if (!view.criteria.length) return "";
    return '<h2>Criteria</h2><div class="card">' + view.criteria.map((c) => {
      const check = c.check.kind === "command" ? "command: " + c.check.command
                  : c.check.kind === "judge" ? "judge: " + c.check.rubric
                  : "none: " + c.check.reason;
      const met = c.met === true ? ' <span class="ok">✓</span>'
                : c.met === false ? ' <span class="bad">✗</span>' : "";
      return '<p class="crit"><span class="id">' + esc(c.id) + '</span>  ' + esc(c.statement) + met +
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
        view.plan.map((t) => '<li><span class="id">' + esc(t.id) + "</span>  [" + esc(t.worker) + "] " +
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
      '<div class="card warn"><strong>' + esc(i.kind) + "</strong> · " + esc(i.text) +
      (i.kind === "question" && i.id
        ? '<div class="row"><input class="reply" data-qid="' + esc(i.id) + '" placeholder="answer…">' +
          '<button class="send-answer" data-qid="' + esc(i.id) + '">answer</button></div>'
        : "") +
      "</div>").join("");
  }

  // The §13 ledger strip: the counts that make a long run legible at a glance, and
  // the outcome criteria as chips. Rendered only once a ledger exists.
  function renderStrip() {
    if (!view.ledger) return "";
    const l = view.ledger;
    const facts = l.factsGiven.length + l.factsVerified.length;
    const outcome = view.criteria.map((c) =>
      '<span class="' + (c.met === true ? "ok" : c.met === false ? "bad" : "quiet") + '">' +
      (c.met === true ? "✓ " : c.met === false ? "✗ " : "○ ") + esc(c.id) + "</span>").join("  ");
    return '<div class="strip">' +
      "<span>✓ " + facts + " facts</span>" +
      "<span>? " + l.factsToLookUp.length + " to look up</span>" +
      "<span>⚠ " + l.deadEnds.length + " dead ends</span>" +
      (outcome ? "<span>outcome  " + outcome + "</span>" : "") +
      "</div>";
  }

  const COLUMNS = [
    ["todo", ["waiting", "todo"]],
    ["running", ["running"]],
    ["verifying", ["verifying", "review"]],
    ["blocked", ["blocked"]],
    ["done", ["done", "failed", "conflicted", "cancelled"]],
  ];
  const OUTCOME_MARK = { done: '<span class="ok">✓</span>', failed: '<span class="bad">✗</span>',
                         conflicted: '<span class="bad">⚠</span>', cancelled: '<span class="quiet">⊘</span>' };

  function taskCard(t) {
    const mins = t.status === "running" && t.startedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(t.startedAt)) / 60000)) + " min" : "";
    const mark = OUTCOME_MARK[t.status] || "";
    return '<div class="task" data-task="' + esc(t.id) + '">' +
      '<span class="id">' + esc(t.id) + "</span> " + mark +
      "<div>" + esc(t.goal.length > 80 ? t.goal.slice(0, 77) + "…" : t.goal) + "</div>" +
      '<div class="meta">' + esc(t.worker) + (mins ? " · " + mins : "") + "</div></div>";
  }

  function renderBoard() {
    const tasks = [...view.tasks.values()];
    if (!tasks.length) return "";
    return '<h2>Tasks</h2><div class="board">' + COLUMNS.map(([title, statuses]) => {
      const cards = tasks.filter((t) => statuses.includes(t.status));
      return '<div class="col"><h3>' + title + " (" + cards.length + ")</h3>" +
        cards.map(taskCard).join("") + "</div>";
    }).join("") + "</div>";
  }

  // §4.2: the chain a human actually wants four hours in. Both edges already exist in
  // the data model, so this is a lookup, not a feature.
  function ledgerEntry(id) {
    const l = view.ledger;
    if (!l) return null;
    const tiers = [
      ["fact", l.factsGiven], ["fact", l.factsVerified], ["to look up", l.factsToLookUp],
      ["to derive", l.factsToDerive], ["guess", l.guesses], ["dead end", l.deadEnds],
    ];
    for (const [label, entries] of tiers) {
      const hit = entries.find((e) => e.id === id);
      if (hit) return { label: label, text: hit.text || hit.approach || "" };
    }
    return null;
  }

  function artifactLine(a) {
    if (a.kind === "diff") return "diff · " + esc(a.branch) + " · " + a.files.length +
      " files +" + a.insertions + " −" + a.deletions;
    if (a.kind === "report") return "report · " + esc(a.text.length > 120 ? a.text.slice(0, 117) + "…" : a.text);
    const caption = a.summary || a.caption || "";
    return esc(a.kind) + " · " + esc(a.path) + (caption ? " · " + esc(caption) : "");
  }

  function renderWhy() {
    const task = view.selected && view.tasks.get(view.selected);
    if (!task) return "";
    const because = (task.motivatedBy || []).map((id) => {
      const entry = ledgerEntry(id);
      return "<dd>" + esc(id) + (entry ? ' <span class="quiet">' + esc(entry.label) + "</span>  " + esc(entry.text) : "") + "</dd>";
    }).join("");
    const serves = (task.satisfies || []).map((id) => {
      const c = view.criteria.find((x) => x.id === id);
      return "<dd>" + esc(id) + (c ? "  " + esc(c.statement) : "") + "</dd>";
    }).join("");
    const produced = view.artifacts.filter((a) => a.taskId === task.id)
      .map((a) => "<dd>" + artifactLine(a.artifact) + "</dd>").join("");
    return '<h2>Why · ' + esc(task.id) + '</h2><div class="card"><dl class="why">' +
      "<dt>goal</dt><dd>" + esc(task.goal) + "</dd>" +
      (because ? "<dt>because</dt>" + because : "") +
      (serves ? "<dt>serves</dt>" + serves : "") +
      (task.dependsOn && task.dependsOn.length ? "<dt>after</dt><dd>" + esc(task.dependsOn.join(", ")) + "</dd>" : "") +
      (produced ? "<dt>produced</dt>" + produced : "") +
      '</dl><div class="row"><button id="close-why">close</button></div></div>';
  }

  // §13's compose card, minus the envelope editor: a composed mission gets the
  // default envelope, and widening it stays a deliberate act elsewhere. No
  // unattended toggle either — skipping sign-off is a typed CLI flag (§17).
  function renderHome() {
    const missions = (view.missions || []).map((m) =>
      '<div class="card"><strong>' + esc(m.goal) + "</strong>" +
      '<div class="quiet mono">' + esc(m.id) + " · " + esc(m.status) + "</div>" +
      '<div class="row"><button class="watch-btn" data-mid="' + esc(m.id) + '">watch</button>' +
      '<button class="forget-btn" data-mid="' + esc(m.id) + '">forget</button></div></div>').join("");
    return '<h2>New mission</h2><div class="card">' +
      '<textarea id="compose-goal" rows="3" placeholder="e.g. Reconcile June invoices across Xero and Ramp. Flag anything that does not match."></textarea>' +
      '<div class="row"><input id="compose-budget" type="number" min="1" placeholder="budget minutes (240)">' +
      '<button class="primary" id="compose-start">start mission</button></div></div>' +
      "<h2>Missions</h2>" + (missions || '<p class="quiet">none yet</p>');
  }

  function render() {
    const home = view.missions !== null && !view.watching;
    $("mission-extras").style.display = home ? "none" : "";

    if (home) {
      $("goal").textContent = "fable-orchestra";
      $("bar").innerHTML = "";
      $("screen").innerHTML = renderHome();
      wire();
      return;
    }

    $("goal").textContent = view.goal || "fable-orchestra";
    $("bar").innerHTML = [
      "status <strong>" + esc(view.status) + "</strong>" + (view.paused ? " ⏸ paused" : ""),
      "round " + view.round,
      "stalls " + view.stalls,
      "resets " + view.resets,
    ].join("</span><span>").replace(/^/, "<span>") + "</span>";
    $("pause").textContent = view.paused ? "resume" : "pause";

    const back = view.missions !== null
      ? '<div class="row"><button id="back-home">← missions</button></div>' : "";
    const screen =
      view.questions.length ? renderIntake() :
      view.status === "awaiting_signoff" ? renderSignoff() :
      renderStrip() + renderCriteria() + renderBoard() + renderWhy() + renderInbox();

    $("screen").innerHTML = back + screen;
    wire();
  }
`;
