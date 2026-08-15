// What each screen says.
//
// Ported from `web/page/screens.ts`, where these were string-concatenating functions
// inside a template literal. Same screens, same words, same order — the port is
// mechanical on purpose, because a rewrite and a restyle in one diff is a diff nobody
// can review. The stylesheet is untouched, so every class name here is one
// `web/page/style.ts` already defines.
//
// Two things the port removes for free. `esc()` is gone: Preact escapes text nodes,
// and hand-rolled escaping was the kind of thing that only fails on the one input
// nobody tried. And the "no backticks, no dollar-brace" rule is gone with the
// template literal that needed it — `shell.test.ts` guarded that and retires with it.
//
// Artifacts still render *metadata only* — kind, path, summary, counts. Serving file
// contents would put a disk-reading route on the approval surface, and that trade is
// still not taken here (§17).
import { type ComponentChildren } from "preact";
import { type WorkspaceProbe } from "../../config/workspaces.js";
import { type Artifact } from "../../domain/artifacts.js";
import { type Criterion } from "../../domain/ledger.js";
import { type ClientMessage } from "../protocol.js";
import { type BoardTask, type View } from "./state.js";

type Send = (message: ClientMessage) => void;

/** Picking a workspace is the page's own business, exactly as selecting a task is: it
 *  moves a highlight and sends nothing. What it *chooses* rides on the next compose,
 *  as an id. */
type Choose = (workspaceId: string) => void;

interface ScreenProps {
  view: View;
  send: Send;
  /** Selecting a task is the page's own business — it opens a panel and sends
   *  nothing. The only view state that is not a projection of the log. */
  onSelect(taskId: string | null): void;
}

const describeCheck = (criterion: Criterion): string =>
  criterion.check.kind === "command"
    ? `command: ${criterion.check.command}`
    : criterion.check.kind === "judge"
      ? `judge: ${criterion.check.rubric}`
      : `none: ${criterion.check.reason}`;

const mark = (met: boolean | undefined): ComponentChildren =>
  met === true ? <span class="ok">✓</span> : met === false ? <span class="bad">✗</span> : null;

function Criteria({ criteria }: { criteria: readonly Criterion[] }) {
  if (criteria.length === 0) return null;
  return (
    <>
      <h2>Criteria</h2>
      <div class="card">
        {criteria.map((criterion) => (
          <p class="crit" key={criterion.id}>
            <span class="id">{criterion.id}</span> {criterion.statement} {mark(criterion.met)}
            <br />
            <span class="check">check ▸ {describeCheck(criterion)}</span>
          </p>
        ))}
      </div>
    </>
  );
}

/** A text box and two buttons, used by both sign-off screens. The words differ
 *  because "revise the plan" and "reject this change" are not the same thing to the
 *  person clicking, but from the port's side it is one decision. */
function ApproveOrRevise({ send, approve, reject, placeholder }: {
  send: Send;
  approve: string;
  reject: string;
  placeholder: string;
}) {
  return (
    <div class="row">
      <button
        class="primary"
        onClick={(event) => {
          (event.currentTarget as HTMLButtonElement).disabled = true;
          send({ kind: "approve" });
        }}
      >
        {approve}
      </button>
      <input id="feedback" placeholder={placeholder} />
      <button
        onClick={() => {
          const box = document.getElementById("feedback") as HTMLInputElement | null;
          const feedback = box?.value.trim();
          if (feedback) send({ kind: "revise", feedback });
        }}
      >
        {reject}
      </button>
    </div>
  );
}

// §13's sign-off screen, returning mid-mission: the diff and the reasoning, above the
// spec they would edit.
function CriteriaChange({ view, send }: { view: View; send: Send }) {
  const change = view.pendingChange;
  if (!change) return null;

  return (
    <>
      <h2>A replan wants to change the contract</h2>
      <div class="card warn">
        <p>{change.reasoning}</p>
        <ul>
          {change.diff.map((op, index) =>
            op.op === "add" ? (
              <li key={index}>
                add <span class="id">{op.criterion.id}</span>
                <br />+ {op.criterion.statement}
              </li>
            ) : op.op === "remove" ? (
              <li key={index}>
                remove <span class="id">{op.criterionId}</span>
                <br />
                because {op.reason}
              </li>
            ) : (
              <li key={index}>
                amend <span class="id">{op.criterionId}</span>
                <br />− {op.from.statement}
                <br />+ {op.to.statement}
                <br />
                because {op.reason}
              </li>
            ),
          )}
        </ul>
      </div>
      <Criteria criteria={view.criteria} />
      <ApproveOrRevise
        send={send}
        approve="approve the change"
        reject="reject"
        placeholder="or say why the criteria should stand…"
      />
    </>
  );
}

function Signoff({ view, send }: { view: View; send: Send }) {
  const estimate = view.estimate;
  const cli = view.plan.filter((task) => task.worker === "code").length;

  return (
    <>
      <h2>Awaiting your approval</h2>
      {view.brief ? <div class="card">{view.brief}</div> : null}
      <Criteria criteria={view.criteria} />

      {view.guesses.length > 0 ? (
        <>
          <h2>Guesses — these could be wrong</h2>
          <div class="card warn">
            <ul>
              {view.guesses.map((guess) => (
                <li key={guess.id ?? guess.text}>
                  {guess.text} <span class="quiet">({guess.confidence})</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {view.outOfScope.length > 0 ? (
        <>
          <h2>Out of scope</h2>
          <div class="card">{view.outOfScope.join("  ·  ")}</div>
        </>
      ) : null}

      <h2>Plan</h2>
      <div class="card scroll">
        <ul>
          {view.plan.map((task) => (
            <li key={task.id}>
              <span class="id">{task.id}</span> [{task.worker}] {task.goal}
              {task.dependsOn.length > 0 ? (
                <span class="quiet"> after {task.dependsOn.join(", ")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {estimate ? (
        <>
          <h2>Estimate</h2>
          <div class="card mono">
            {estimate.taskCount} tasks · ~{Math.round(estimate.wallMs / 60000)} min ·{" "}
            {estimate.expectedGates} gates
            <br />~{Math.round(estimate.tokens / 1000)}k tokens measured, {cli} CLI runs unmeasured
          </div>
        </>
      ) : null}

      <ApproveOrRevise
        send={send}
        approve="approve"
        reject="revise"
        placeholder="or say what should change…"
      />
    </>
  );
}

function Intake({ view, send }: { view: View; send: Send }) {
  return (
    <>
      <h2>A few questions before this is planned</h2>
      {view.questions.map((question, index) => (
        <div class="card" key={question.id}>
          <p>
            {index + 1}. {question.question}
          </p>
          {question.options ? <p class="quiet">{question.options.join("  /  ")}</p> : null}
          <input class="answer" data-qid={question.id} placeholder="leave blank to skip" />
        </div>
      ))}
      <div class="row">
        <button
          class="primary"
          onClick={(event) => {
            (event.currentTarget as HTMLButtonElement).disabled = true;
            const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("input.answer"));
            send({
              kind: "intake",
              answers: boxes.map((box) => ({ questionId: box.dataset.qid ?? "", answer: box.value })),
            });
          }}
        >
          send answers
        </button>
      </div>
    </>
  );
}

function Inbox({ view, send }: { view: View; send: Send }) {
  const items = [...view.inbox.entries()].filter(([, item]) => item.kind !== "intake");
  if (items.length === 0) return null;

  return (
    <>
      <h2>Inbox</h2>
      {items.map(([key, item]) => (
        <div class="card warn" key={key}>
          <strong>{item.kind}</strong> · {item.text}

          {item.kind === "question" && item.id ? (
            <div class="row">
              <input class="reply" data-qid={item.id} placeholder="answer…" />
              <button
                onClick={() => {
                  const box = document.querySelector<HTMLInputElement>(`input.reply[data-qid="${item.id}"]`);
                  const answer = box?.value.trim();
                  if (!answer || !item.id) return;
                  send({
                    kind: "answer",
                    questionId: item.id,
                    answer,
                    ...(view.watching ? { missionId: view.watching } : {}),
                  });
                }}
              >
                answer
              </button>
            </div>
          ) : null}

          {/* Two buttons and no text box: a permission is a yes or a no, and a worker
              is waiting on it (§12). Neither is the primary button — nothing here is
              the one you tap through without reading (§11). */}
          {item.kind === "permission" && item.id ? (
            <div class="row">
              <button onClick={() => resolve(send, view, item.id, true)}>allow</button>
              <button onClick={() => resolve(send, view, item.id, false)}>deny</button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** The watched mission's id rides along for the same reason an answer's does: a serve
 *  dashboard may be looking at a mission other than the one this tab started. */
function resolve(send: Send, view: View, requestId: string | undefined, approved: boolean): void {
  if (!requestId) return;
  send({
    kind: "resolve",
    requestId,
    approved,
    ...(view.watching ? { missionId: view.watching } : {}),
  });
}

/** The §13 ledger strip: the counts that make a long run legible at a glance, and the
 *  outcome criteria as chips. Rendered only once a ledger exists. */
function Strip({ view }: { view: View }) {
  const ledger = view.ledger;
  if (!ledger) return null;
  const facts = ledger.factsGiven.length + ledger.factsVerified.length;

  return (
    <div class="strip">
      <span>✓ {facts} facts</span>
      <span>? {ledger.factsToLookUp.length} to look up</span>
      <span>⚠ {ledger.deadEnds.length} dead ends</span>
      {view.criteria.length > 0 ? (
        <span>
          outcome{" "}
          {view.criteria.map((criterion) => (
            <span
              key={criterion.id}
              class={criterion.met === true ? "ok" : criterion.met === false ? "bad" : "quiet"}
            >
              {criterion.met === true ? "✓ " : criterion.met === false ? "✗ " : "○ "}
              {criterion.id}{" "}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

const COLUMNS: readonly [string, readonly string[]][] = [
  ["todo", ["waiting", "todo"]],
  ["running", ["running"]],
  ["verifying", ["verifying", "review"]],
  ["blocked", ["blocked"]],
  ["done", ["done", "failed", "conflicted", "cancelled"]],
];

const OUTCOME_MARK: Record<string, ComponentChildren> = {
  done: <span class="ok">✓</span>,
  failed: <span class="bad">✗</span>,
  conflicted: <span class="bad">⚠</span>,
  cancelled: <span class="quiet">⊘</span>,
};

function TaskCard({ task, onSelect }: { task: BoardTask; onSelect: (id: string) => void }) {
  const minutes =
    task.status === "running" && task.startedAt
      ? `${Math.max(0, Math.round((Date.now() - Date.parse(task.startedAt)) / 60000))} min`
      : "";

  // The status is a class as well as a mark, because the stylesheet is where "a
  // running task is the only thing on the board that moves" is enforced.
  return (
    <div class={`task task-${task.status}`} onClick={() => onSelect(task.id)}>
      <span class="id">{task.id}</span> {OUTCOME_MARK[task.status] ?? null}
      <div>{task.goal.length > 80 ? `${task.goal.slice(0, 77)}…` : task.goal}</div>
      <div class="meta">
        {task.worker}
        {minutes ? ` · ${minutes}` : ""}
      </div>
    </div>
  );
}

function Board({ view, onSelect }: { view: View; onSelect: (id: string) => void }) {
  const tasks = [...view.tasks.values()];
  if (tasks.length === 0) return null;

  return (
    <>
      <h2>Tasks</h2>
      <div class="board">
        {COLUMNS.map(([title, statuses]) => {
          const cards = tasks.filter((task) => statuses.includes(task.status));
          return (
            <div class="col" key={title}>
              <h3>
                {title} ({cards.length})
              </h3>
              {cards.map((task) => (
                <TaskCard key={task.id} task={task} onSelect={onSelect} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

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

function Why({ view, onSelect }: { view: View; onSelect: (id: string | null) => void }) {
  const task = view.selected ? view.tasks.get(view.selected) : undefined;
  if (!task) return null;

  const produced = view.artifacts.filter((written) => written.taskId === task.id);

  return (
    <>
      <h2>Why · {task.id}</h2>
      <div class="card">
        <dl class="why">
          <dt>goal</dt>
          <dd>{task.goal}</dd>

          {task.motivatedBy && task.motivatedBy.length > 0 ? (
            <>
              <dt>because</dt>
              {task.motivatedBy.map((id) => {
                const entry = ledgerEntry(view, id);
                return (
                  <dd key={id}>
                    {id}
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
                    {id}
                    {criterion ? `  ${criterion.statement}` : ""}
                  </dd>
                );
              })}
            </>
          ) : null}

          {task.dependsOn.length > 0 ? (
            <>
              <dt>after</dt>
              <dd>{task.dependsOn.join(", ")}</dd>
            </>
          ) : null}

          {produced.length > 0 ? (
            <>
              <dt>produced</dt>
              {produced.map((written, index) => (
                <dd key={index}>{artifactLine(written.artifact)}</dd>
              ))}
            </>
          ) : null}
        </dl>
        <div class="row">
          <button onClick={() => onSelect(null)}>close</button>
        </div>
      </div>
    </>
  );
}

/** What discovery found for a directory, as one line per fact (UI plan U4). Every
 *  line is observed rather than settable — the UI shows what was probed and never
 *  offers a field to declare it (§2a rule 3). */
function Discovered({ probe }: { probe: WorkspaceProbe }) {
  return (
    <dl class="why">
      <dt>path</dt>
      <dd class="mono">{probe.path}</dd>
      <dt>git</dt>
      <dd>{probe.repoRoot ? `repo at ${probe.repoRoot}` : "not a git repo — research and computer missions still run"}</dd>
      <dt>verify</dt>
      <dd>{probe.verify ? `${probe.verify.command}  (from ${probe.verify.source})` : "none found — code tasks merge without a project gate"}</dd>
      <dt>workers</dt>
      <dd>{probe.agents.length > 0 ? probe.agents.join(", ") : "none on PATH — no code task can be dispatched"}</dd>
      <dt>state</dt>
      <dd class="mono">{probe.stateDir}</dd>
    </dl>
  );
}

/** The workspace picker and the add flow. Two steps, and the split is the design: a
 *  probe resolves and reports, and only then is there anything to confirm. The server
 *  refuses an add it did not just resolve, so this is the readable half of a rule that
 *  is enforced elsewhere. */
function Workspaces({ view, send, onChoose }: { view: View; send: Send; onChoose: Choose }) {
  const { list, probe, live, chosen, defaultId } = view.workspaces;
  if (!list) return null;

  return (
    <>
      <h2>Workspace</h2>
      {list.map((workspace) => {
        const busy = live[workspace.id];
        return (
          <div
            class={`card${workspace.id === chosen ? " chosen" : ""}`}
            key={workspace.id}
            onClick={() => onChoose(workspace.id)}
          >
            <strong class="mono">{workspace.path}</strong>
            <div class="quiet">
              {workspace.id === defaultId ? "where serve was started" : "added"}
              {busy ? ` · mission ${busy} is running here` : ""}
            </div>
            {workspace.id !== defaultId && !busy ? (
              <div class="row">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    send({ kind: "workspace_forget", workspaceId: workspace.id });
                  }}
                >
                  remove
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      <div class="card">
        <div class="row">
          <input id="workspace-path" placeholder="another directory, e.g. ~/code/ledger" />
          <button
            onClick={() => {
              const box = document.getElementById("workspace-path") as HTMLInputElement | null;
              const typed = box?.value.trim();
              if (typed) send({ kind: "workspace_probe", path: typed });
            }}
          >
            check
          </button>
        </div>

        {probe ? (
          <>
            <Discovered probe={probe} />
            {probe.problem ? <p class="bad">{probe.problem}</p> : null}
            {probe.registered ? <p class="quiet">already a workspace</p> : null}
            {!probe.problem && !probe.registered ? (
              <div class="row">
                <button
                  onClick={() =>
                    send({ kind: "workspace_add", path: probe.path, create: !probe.exists })
                  }
                >
                  {probe.exists ? "add this directory" : "create it and add it"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

/** §13's compose card, minus the envelope editor: a composed mission gets the default
 *  envelope, and widening it stays a deliberate act elsewhere. No unattended toggle
 *  either — skipping sign-off is a typed CLI flag (§17). */
function Home({ view, send, onChoose }: { view: View; send: Send; onChoose: Choose }) {
  const { chosen, live, list } = view.workspaces;
  const target = list?.find((workspace) => workspace.id === chosen);
  const busy = chosen ? live[chosen] : undefined;

  return (
    <>
      <Workspaces view={view} send={send} onChoose={onChoose} />

      <h2>New mission</h2>
      <div class="card">
        {target ? <p class="quiet mono">in {target.path}</p> : null}
        <textarea
          id="compose-goal"
          rows={3}
          placeholder="e.g. Reconcile June invoices across Xero and Ramp. Flag anything that does not match."
        />
        <div class="row">
          <input id="compose-budget" type="number" min="1" placeholder="budget minutes (240)" />
          <button
            class="primary"
            disabled={busy !== undefined}
            onClick={() => {
              const goalBox = document.getElementById("compose-goal") as HTMLTextAreaElement | null;
              const budgetBox = document.getElementById("compose-budget") as HTMLInputElement | null;
              const goal = goalBox?.value.trim();
              if (!goal) return;
              const budget = Number(budgetBox?.value);
              send({
                kind: "compose",
                goal,
                // The one value that comes from the page's own state, and it is the
                // id of the workspace row that was clicked — the stated exception to
                // the containment rule, and an id rather than a path by design.
                ...(chosen ? { workspaceId: chosen } : {}),
                ...(Number.isFinite(budget) && budget > 0 ? { budgetMinutes: budget } : {}),
              });
            }}
          >
            start mission
          </button>
        </div>
        {busy ? (
          <p class="quiet">mission {busy} is running in this directory — one at a time per workspace.</p>
        ) : null}
      </div>

      <h2>Missions</h2>
      {view.missions && view.missions.length > 0 ? (
        view.missions.map((mission) => (
          <div class="card" key={mission.id}>
            <strong>{mission.goal}</strong>
            <div class="quiet mono">
              {mission.id} · {mission.status}
            </div>
            <div class="row">
              <button onClick={() => send({ kind: "watch", missionId: mission.id })}>watch</button>
              <button onClick={() => send({ kind: "forget", missionId: mission.id })}>forget</button>
            </div>
          </div>
        ))
      ) : (
        <p class="quiet">none yet</p>
      )}
    </>
  );
}

/**
 * Which screen, in priority order.
 *
 * `pendingChange` outranks `awaiting_signoff` deliberately: a reopened mission carries
 * the same status one field apart (§3), and showing the plan screen would put an
 * approve button under a contract change nobody was shown.
 */
export function Screen({ view, send, onSelect }: ScreenProps) {
  if (view.questions.length > 0) return <Intake view={view} send={send} />;
  if (view.pendingChange) return <CriteriaChange view={view} send={send} />;
  if (view.status === "awaiting_signoff") return <Signoff view={view} send={send} />;

  return (
    <>
      <Strip view={view} />
      <Criteria criteria={view.criteria} />
      <Board view={view} onSelect={onSelect} />
      <Why view={view} onSelect={onSelect} />
      <Inbox view={view} send={send} />
    </>
  );
}

export { Home };
