// The task panel, in two sizes.
//
// One task has more to say than any rail can hold: a goal that is a two-thousand
// character specification, a system prompt several times that, a spec sheet, the plan
// provenance and whatever it produced. The old panel put the first of those, unclamped,
// into a 20rem rail and left out the rest — so the answer to "what is this agent and
// what was it told" was a wall of text that did not contain it.
//
// The split is the fix and it is the same one the rails already make. `TaskBrief` is
// the rail's card: who this is, what it is doing, four lines of the goal, and a way in.
// `TaskDossier` is a centre pane — the width of the board, because that is what a
// prompt needs — and it holds everything, with the longest two things folded.
//
// Selecting a task does not move the pane. Clicking a card on the board would otherwise
// replace the board, which is the one panel U7 says must stay.
import { type Artifact } from "../../domain/artifacts.js";
import { type ClientMessage } from "../protocol.js";
import { agentFacts, agentLine, type Fact } from "./dossier.js";
import { type BoardTask, type View } from "./state.js";

type Send = (message: ClientMessage) => void;

/** §4.2: the chain a human actually wants four hours in. Both edges already exist in
 *  the data model, so this is a lookup, not a feature. */
function ledgerEntry(view: View, id: string): { label: string; text: string } | null {
  const ledger = view.ledger;
  if (!ledger) return null;

  const tiers: readonly [string, readonly { id: string; text?: string; approach?: string }[]][] = [
    ["fact", ledger.factsGiven],
    ["fact", ledger.factsVerified],
    ["to look up", ledger.factsToLookUp],
    ["to derive", ledger.factsToDerive],
    ["guess", ledger.guesses],
    ["dead end", ledger.deadEnds],
  ];

  for (const [label, entries] of tiers) {
    const hit = entries.find((entry) => entry.id === id);
    if (hit) return { label, text: hit.text ?? hit.approach ?? "" };
  }
  return null;
}

const artifactLine = (artifact: Artifact): string => {
  if (artifact.kind === "diff") {
    return `diff · ${artifact.branch} · ${artifact.files.length} files +${artifact.insertions} −${artifact.deletions}`;
  }
  if (artifact.kind === "report") {
    return `report · ${artifact.text.length > 120 ? `${artifact.text.slice(0, 117)}…` : artifact.text}`;
  }
  const caption = "summary" in artifact ? artifact.summary : "caption" in artifact ? artifact.caption : "";
  return `${artifact.kind} · ${artifact.path}${caption ? ` · ${caption}` : ""}`;
};

/** The spec sheet. A list value is drawn as chips rather than as a comma string,
 *  because every one of them — tools, lease globs, domains — is read by scanning for
 *  one entry rather than by reading the line. */
function Sheet({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl class="sheet">
      {facts.map((fact) => (
        <div class="sheet-row" key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            {fact.values.length === 1 ? (
              <span class={fact.mono ? "mono" : undefined}>{fact.values[0]}</span>
            ) : (
              <span class="chips">
                {fact.values.map((value) => (
                  <span class={`chip${fact.mono ? " mono" : ""}`} key={value}>
                    {value}
                  </span>
                ))}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The rail's card: enough to know what is selected, and no wall of text. The goal is
 *  clamped in CSS rather than sliced here, so what is on screen is the real string and
 *  a person can still select it. */
export function TaskBrief({ view, onOpen, onSelect }: {
  view: View;
  onOpen(): void;
  onSelect(taskId: string | null): void;
}) {
  const task = view.selected ? view.tasks.get(view.selected) : undefined;
  if (!task) return null;

  return (
    <>
      <h2>Selected · {task.id}</h2>
      <div class="card">
        <p class="agent-line">{agentLine(task)}</p>
        <p class="clamp">{task.goal}</p>
        <div class="row">
          <button onClick={onOpen}>open the dossier</button>
          <button onClick={() => onSelect(null)}>close</button>
        </div>
      </div>
    </>
  );
}

/**
 * Everything about one task, at the width of the board.
 *
 * Order is the order the questions come in: what was it asked to do, who is doing it,
 * what were they told, why does this task exist, and what came out. The prompt is
 * folded because it is the longest thing on the page and it is read once.
 */
export function TaskDossier({ view, send, onSelect }: {
  view: View;
  send: Send;
  onSelect(taskId: string | null): void;
}) {
  const task = view.selected ? view.tasks.get(view.selected) : undefined;
  if (!task) {
    return <p class="quiet">No task selected. Pick one on the board and it opens here.</p>;
  }

  const produced = view.artifacts.filter((written) => written.taskId === task.id);
  // Promotion is addressed by mission id, which only a serve dashboard has: a per-run
  // server holds one mission and refuses the message, so the row is not offered there.
  const missionId = view.watching;

  return (
    <div class="dossier">
      <h2>
        {task.id} · {task.status}
      </h2>

      <div class="card">
        <h3>goal</h3>
        {/* pre-wrap, not prose: a synthesized goal is a numbered specification and the
            numbering is the only structure it has. */}
        <p class="spec">{task.goal}</p>
        {task.successCriteria.length > 0 ? (
          <ul class="spec-list">
            {task.successCriteria.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <h2>The agent</h2>
      <div class="card">
        <Sheet facts={agentFacts(task)} />
      </div>

      {/* The whole of what this worker was told, which is the one thing that explains a
          result nobody expected. Folded: it is thousands of characters and it is read
          once, when something has gone wrong. */}
      <details class="fold">
        <summary>system prompt · {task.agentSpec.systemPrompt.length.toLocaleString()} characters</summary>
        <pre class="prompt">{task.agentSpec.systemPrompt}</pre>
      </details>

      <Provenance view={view} task={task} />

      {produced.length > 0 ? (
        <>
          <h2>Produced</h2>
          <div class="card">
            <ul class="spec-list">
              {produced.map((written, index) => (
                <li class="mono" key={index}>
                  {artifactLine(written.artifact)}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <div class="row">
        {/* Promote this task's synthesized agent to procedural memory (§6, §7, U6).
            Here rather than on the board, because a role worth keeping is one somebody
            watched do the work — and this is the panel they were reading while it did.
            Human-initiated by design: nothing in the loop sends this. */}
        {missionId ? (
          <>
            <input class="promote-name" data-task={task.id} placeholder="keep this agent as…" />
            <button
              onClick={() => {
                const box = document.querySelector<HTMLInputElement>(
                  `input.promote-name[data-task="${task.id}"]`,
                );
                const name = box?.value.trim();
                if (name) send({ kind: "promote", missionId, taskId: task.id, name });
              }}
            >
              promote
            </button>
          </>
        ) : null}
        <button onClick={() => onSelect(null)}>close</button>
      </div>
    </div>
  );
}

/** Why this task exists: the ledger entries that motivated it, the criteria it serves,
 *  and what it waited for. Unchanged in content from the panel this replaces — it was
 *  the one part of it that was right. */
function Provenance({ view, task }: { view: View; task: BoardTask }) {
  const hasAny =
    (task.motivatedBy && task.motivatedBy.length > 0) ||
    (task.satisfies && task.satisfies.length > 0) ||
    task.dependsOn.length > 0;
  if (!hasAny) return null;

  return (
    <>
      <h2>Why this task</h2>
      <div class="card">
        <dl class="why">
          {task.motivatedBy && task.motivatedBy.length > 0 ? (
            <>
              <dt>because</dt>
              {task.motivatedBy.map((id) => {
                const entry = ledgerEntry(view, id);
                return (
                  <dd key={id}>
                    <span class="id">{id}</span>
                    {entry ? (
                      <>
                        {" "}
                        <span class="quiet">{entry.label}</span> {entry.text}
                      </>
                    ) : null}
                  </dd>
                );
              })}
            </>
          ) : null}

          {task.satisfies && task.satisfies.length > 0 ? (
            <>
              <dt>serves</dt>
              {task.satisfies.map((id) => {
                const criterion = view.criteria.find((each) => each.id === id);
                return (
                  <dd key={id}>
                    <span class="id">{id}</span> {criterion ? criterion.statement : ""}
                  </dd>
                );
              })}
            </>
          ) : null}

          {task.dependsOn.length > 0 ? (
            <>
              <dt>after</dt>
              <dd class="mono">{task.dependsOn.join(", ")}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </>
  );
}
