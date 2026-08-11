// The page's socket and event handlers — everything that *sends*.
//
// Split from the screens deliberately: the containment stated in `projection.ts` is
// that no decision derives from the page's own fold, and keeping every `send()` in
// one short file is what makes that reviewable. A send here carries what a human
// typed or clicked, never a value computed from `view` — the one exception is an id
// read off the clicked element, which names *what* was clicked, not what to do
// about it.
//
// Client-side JavaScript in a string: no backticks, no dollar-brace.
export const pageWire = `
  let socket;
  const send = (message) => socket && socket.readyState === 1 && socket.send(JSON.stringify(message));

  // Answers a live worker's permission request. The watched mission's id rides along
  // for the same reason an answer's does: a serve dashboard may be looking at a
  // mission other than the one this tab started.
  function sendResolve(requestId, approved) {
    if (!requestId) return;
    const message = { kind: "resolve", requestId: requestId, approved: approved };
    if (view.watching) message.missionId = view.watching;
    send(message);
  }

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

    for (const btn of document.querySelectorAll(".send-answer")) {
      btn.onclick = () => {
        const input = document.querySelector('.reply[data-qid="' + btn.dataset.qid + '"]');
        const answer = input ? input.value.trim() : "";
        if (!answer) return;
        // The watched mission's id rides along so a serve process can answer a
        // mission that is parked rather than live.
        const message = { kind: "answer", questionId: btn.dataset.qid, answer: answer };
        if (view.watching) message.missionId = view.watching;
        send(message);
      };
    }

    // Two loops rather than one reading the button's class, so the decision sent is a
    // literal in the handler that was bound: the only thing derived from the page here
    // is the id of the element that was clicked.
    for (const btn of document.querySelectorAll(".allow-perm")) {
      btn.onclick = () => sendResolve(btn.dataset.rid, true);
    }
    for (const btn of document.querySelectorAll(".deny-perm")) {
      btn.onclick = () => sendResolve(btn.dataset.rid, false);
    }

    for (const card of document.querySelectorAll(".task")) {
      card.onclick = () => { view.selected = card.dataset.task; render(); };
    }
    const close = $("close-why");
    if (close) close.onclick = () => { view.selected = null; render(); };

    const compose = $("compose-start");
    if (compose) {
      compose.onclick = () => {
        const goal = $("compose-goal").value.trim();
        if (!goal) return;
        compose.disabled = true;
        const minutes = Number($("compose-budget").value);
        const message = { kind: "compose", goal: goal };
        if (Number.isFinite(minutes) && minutes > 0) message.budgetMinutes = minutes;
        send(message);
        $("compose-goal").value = "";
      };
    }

    for (const btn of document.querySelectorAll(".watch-btn")) {
      btn.onclick = () => watch(btn.dataset.mid);
    }
    for (const btn of document.querySelectorAll(".forget-btn")) {
      btn.onclick = () => {
        if (confirm("Delete everything this mission wrote?")) {
          send({ kind: "forget", missionId: btn.dataset.mid });
        }
      };
    }
    const back = $("back-home");
    if (back) back.onclick = () => { view.watching = null; render(); };
  }

  function watch(missionId) {
    view.watching = missionId;
    resetMission();
    $("log").innerHTML = "";
    send({ kind: "watch", missionId: missionId });
    render();
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

  // Pause drains and parks; the same button lifts it once paused. The label is kept
  // current by render(), which may only touch this static control's text — never
  // an input's value.
  $("pause").onclick = () => {
    const message = { kind: view.paused ? "unpause" : "pause" };
    if (view.watching) message.missionId = view.watching;
    send(message);
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

    // A fresh socket replays from seq 0, so the view starts over with it — applying
    // a replay on top of a stale view would double every count. A tab that was
    // watching re-watches, which is the same replay by another name.
    socket.onopen = () => {
      resetMission();
      $("log").innerHTML = "";
      if (view.watching) send({ kind: "watch", missionId: view.watching });
    };

    socket.onmessage = (frame) => {
      const message = JSON.parse(frame.data);
      if (message.kind === "rejected") { console.warn("rejected:", message.problem); return; }

      if (message.kind === "missions") {
        // Redrawn only on change: the listing arrives on every publish, and a
        // rewrite per event would wipe whatever the compose box holds mid-thought.
        const json = JSON.stringify(message.missions);
        if (json === view.missionsJson) return;
        view.missions = message.missions;
        view.missionsJson = json;
        render();
        return;
      }

      if (message.kind !== "events") return;
      // Ignore a stale stream: after "back", the server may still be pushing the
      // previously watched mission's events.
      if (view.missions !== null && !view.watching) return;

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
`;
