// The decision points (§3). Every model call the orchestrator makes is one of these;
// a model call that is not on this list does not exist.
//
// This interface is the seam the loop is written against, which is what lets the
// whole loop run in tests against scripted answers with no model and no spend.
//
// §3 names five and `intake` is the sixth, which needs saying because the rule above
// is worth keeping honest. §3 carved intake out as "a real conversation" running in
// streaming-input mode, on the reading that it asks follow-ups off an answer. §2b
// caps it at three questions asked once, and once is not a conversation. So it lands
// here as an ordinary one-shot call instead — which keeps it above this seam, where
// the cap and the answers are assertable with no model. A streaming intake session
// would sit below it, in the one file six defects hid in.
import { type AgentSpec } from "../domain/task.js";
import { type Envelope } from "../domain/envelope.js";
import { type Evidence, type VerifySpec } from "../domain/artifacts.js";
import {
  type Criterion,
  type Finding,
  type Guess,
  type PlannedTask,
  type ProgressLedger,
  type TaskLedger,
} from "../domain/ledger.js";
import { type WorkerReport } from "../domain/report.js";

export interface ResearchInput {
  question: string;
  sources: ("memory" | "codebase" | "web" | "prior-art" | "apps")[];
  depth: "scan" | "deep";
  /**
   * What semantic memory already established, so research is not paid for twice
   * (§5, §6).
   *
   * Memory-sourced facts only. A fact this mission's own scan produced is not
   * "already known" in the sense that matters here — telling the research call it
   * knows what it just found is how a mission talks itself out of doing the work. A
   * stale memory is not here either: it entered the ledger as a guess precisely
   * because it must be re-verified rather than trusted.
   */
  known?: string[];
  /**
   * A saved mission's criteria skeleton (§7): what this job was judged against last
   * time, as a starting point to converge on.
   *
   * Statements only, and that is the point of the type. A replay re-runs scan and
   * research every time because the environment moved since March even if the job did
   * not, so handing the research call `met` or a piece of evidence would be handing it
   * last month's answer to this month's question.
   */
  priorCriteria?: { statement: string }[];
  /**
   * True when this call is the *only* research the mission will get — the scan on a
   * mission a human composed as quick.
   *
   * Without it the scan is asked for criteria and reasonably declines: it has been
   * told it is a scan, and on an ordinary mission the deep call is what writes the
   * outcome spec. Observed on a real run (2026-08-15): the scan returned no criteria,
   * `writeOutcomeSpec` refused `(empty)`, and the mission escalated to the deep call —
   * so quick cost two research calls instead of one and saved nothing. The field is
   * what makes the scan's own answer load-bearing on the run where it is.
   */
  solePass?: boolean;
  /**
   * Present only on the one retry, quoting what `writeOutcomeSpec` refused and why.
   *
   * `plan` has had `reason` and `synthesize` has had `rejected` since Phase 2, and
   * `research` re-ran on a byte-identical input — so the call whose answer decides
   * whether the mission can ever legitimately report success was the one asked to
   * guess again. The rejection is context the system already paid for; discarding it
   * and re-deriving it is how a retry becomes a coin flip.
   */
  rejected?: string;
  /**
   * The repository as a rendered map — directories with file counts and the opening of
   * its top-level docs (PLAN-NEXT 8.1, `config/kb.ts`).
   *
   * A **rendered string** for `SynthesizeInput.roster`'s reason: `describe()` JSON-dumps
   * whatever it is given, and a list of paths would spend the whole budget on punctuation.
   * Budgeted by `KB_INDEX_BUDGET` at the seam that builds it.
   *
   * This call has no tools (§3), so without it the codebase source in `sources` is a
   * heading over nothing. Absent when the mission has no repository, when HEAD has no
   * commit, or when the cache could not be built — every one of which is a mission that
   * ran before this existed.
   */
  repoKb?: string;
  /**
   * Read-only egress for this call, and absent on every mission that did not grant it
   * (PLAN-NEXT 11.3, `Envelope.research`).
   *
   * Present means `WebSearch` and `WebFetch`; `domains` is the allowlist `WebFetch` is
   * held to, and it may legitimately be empty — a grant with no host named still gets
   * search, and every fetch is denied in-call and reported afterwards.
   *
   * An object rather than a boolean beside a list, so "granted" is one fact rather than
   * two fields that can disagree: an empty `domains` array is not the same statement as
   * no grant, and `absent` is the only thing that turns the tools off.
   */
  web?: { domains: string[] };
}

export interface ResearchResult {
  brief: string;
  findings: Finding[];
  confidence: "high" | "medium" | "low";
  /**
   * The outcome spec (§5). Written by the research call rather than by a sixth
   * decision point, because §3 caps the list at five and the spec has to exist
   * before `plan` runs — criteria are an *input* to planning.
   *
   * Deliberately untyped: this is model output, and `writeOutcomeSpec` is the
   * boundary that rejects a criterion carrying no check. A `Criterion[]` here would
   * make the rejectable case unrepresentable and the validation untestable.
   */
  criteria?: readonly unknown[];
  guesses?: Guess[];
  outOfScope?: string[];
  /**
   * Hosts a granted call tried to fetch and was denied, because `Envelope.domains` does
   * not name them (PLAN-NEXT 11.3).
   *
   * Not model output — the transport records it, and no schema validates it, which is
   * why it is here rather than in `researchSchema`. The call carries on either way; the
   * hosts arrive at `prepareMission` and become one advisory `question_asked`, which is
   * `raiseSecrets`' rule: a missing grant is a question, never a stop.
   */
  deniedHosts?: string[];
}

export interface ArchitectInput {
  goal: string;
  /** What research concluded, in its own words. */
  brief: string;
  /** The evidence the design has to be true of, carried whole — this call is the one
   *  place the findings are read for *shape* rather than for gaps, and summarizing them
   *  here would put a second, undeclared reducer between research and the spec. */
  findings: Finding[];
  /** Answers a human gave at intake, and anything memory contributed. The architect runs
   *  after intake for the reason the deep research pass does (§2b): a design settled
   *  before the answers arrived is a design of the wrong thing. */
  known?: string[];
  /** A saved mission's criteria skeleton (§7), statements only — the same shape and the
   *  same reason as `ResearchInput.priorCriteria`. */
  priorCriteria?: { statement: string }[];
  /** Present only on the one retry, quoting what `writeOutcomeSpec` refused. */
  rejected?: string;
  /**
   * The specialist scanners this mission may use as a criterion's check (PLAN-NEXT 6.3),
   * or absent — which is every mission until a human grants one.
   *
   * The architect and not `research`, because a scanner offer belongs to the call that
   * writes the outcome spec on the mission that can afford one. `research` writes the
   * spec only on a *quick* mission, which is a human saying the job is small, and a
   * mission composed as small is precisely the one not to spend a per-file security scan
   * on. Absent means the `scanner` kind does not exist for this mission; naming one
   * anyway is refused by `writeOutcomeSpec`, which is the other half of this pair.
   */
  scanners?: string[];
  /**
   * The repository as a rendered map (PLAN-NEXT 8.1) — the same string `research` gets,
   * from the same cache, and absent for the same reasons.
   *
   * This is the call that names concrete files and concrete interfaces in a design note
   * every code worker then opens, and it has no tools to check that any of them exist.
   * The map is what a directory named in that note is checked against; it is still a
   * snapshot of a commit rather than a listing, which is what the prompt says about it.
   */
  repoKb?: string;
}

export interface ArchitectResult {
  /**
   * The outcome spec (§5), which was `research`'s to write until PLAN-NEXT 5.1.
   *
   * Deliberately untyped for the reason it was untyped there: this is model output and
   * `writeOutcomeSpec` is the boundary that rejects a criterion carrying no check. A
   * `Criterion[]` here would make the rejectable case unrepresentable.
   */
  criteria?: readonly unknown[];
  /**
   * The design, as markdown, written to the mission's artifacts directory and handed to
   * code workers as a path.
   *
   * Text rather than a structured shape: it is read by another model and by a human, and
   * a schema over it would be this file guessing which sections a design needs.
   */
  designNote: string;
  /**
   * Environment variable *names* the design says the work needs (PLAN-NEXT 7.1).
   *
   * A field rather than a sentence dug out of the note, because the names are read by
   * code — `prepareMission` compares them against `Envelope.env` and raises the ones
   * nobody granted — and reading them back out of markdown would be a scanner over
   * model output, which this codebase has got wrong four times (defects 34, 37, 38, 44).
   *
   * Names only. A model that writes a value here would put a credential in the event
   * log, so the prompt says so and `secret_required` carries names by schema.
   */
  envVars?: string[];
  guesses?: Guess[];
  outOfScope?: string[];
}

export interface IntakeInput {
  goal: string;
  /**
   * What the scan turned up, and the reason intake runs after it rather than before
   * (§2b). Asked blind, the three questions come back generic — "what does done look
   * like?", which the human already answered by writing the brief. Asked over
   * findings, they can name the two test commands the repo actually has.
   */
  findings: Finding[];
  /** Already-stated facts, so the same thing is not asked twice across a resume. */
  known: string[];
  envelope: Envelope;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  /** Offered where the answer is a choice; free text otherwise. */
  options?: string[];
}

export interface IntakeResult {
  questions: IntakeQuestion[];
}

export interface PlanInput {
  goal: string;
  ledger: TaskLedger;
  envelope: Envelope;
  /** Present on a replan; absent on the first plan. */
  reason?: string;
  /**
   * Present when a human ticked `quick` at compose time: a small job, to be planned as
   * one task rather than decomposed.
   *
   * Deliberately not enforced by a task-count cap in `validatePlan`. Task count is a
   * cost preference rather than a safety invariant, and a cap would fail a mission
   * outright over a mis-ticked box — while the human already sees `estimate.taskCount`
   * at sign-off, which is the cheaper place to catch it. Revisit if real runs show the
   * planner ignoring this.
   */
  scope?: "quick";
  /**
   * The architect's design note as a bounded summary, never the note itself
   * (PLAN-NEXT 5.2).
   *
   * A projection rather than an aggregation: the note is written to be read by a worker
   * with a file open, and pasting it whole into the planning call would grow the one
   * prompt that already carries the entire ledger. The planner needs to know what shape
   * the work has, and the worker needs the detail — those are different amounts of text.
   */
  design?: string;
}

export interface CritiqueInput {
  goal: string;
  /** The breakdown under attack. */
  tasks: PlannedTask[];
  /** What the plan has to satisfy — an objection is only worth raising against the
   *  contract the mission is actually judged on. */
  criteria: Criterion[];
  /**
   * The architect's design summary, on a moonshot mission only (PLAN-NEXT 8.2) — the
   * design review round.
   *
   * The same projection the planner gets, never the note itself: this is the call that
   * reads a breakdown against what it was supposed to implement, and an objection it can
   * raise here ("the design puts the migration behind a flag and no task creates one")
   * is one the planner can act on in the replan it already buys. Absent everywhere else,
   * so a standard mission's critique prompt carries the bytes it carried before.
   */
  design?: string;
}

export interface Objection {
  /** What class of mistake this is, in the critic's own words. Free text rather than an
   *  enum: the prompt names four kinds and a critic that finds a fifth should be able to
   *  say so, and nothing branches on the value — it is read by the planner and by a
   *  human. */
  kind: string;
  detail: string;
  /** The task the objection is about, where it is about one. */
  taskId?: string;
}

export interface CritiqueResult {
  objections: Objection[];
}

export interface PlanResult {
  tasks: PlannedTask[];
  /**
   * The criteria the planner believes the mission should be judged against.
   *
   * Returned rather than applied. After sign-off the loop diffs this against the
   * frozen set and turns any difference into a `criteria_change_requested` — so a
   * planner that cannot meet a criterion can *ask* to relax it and can never do it,
   * whatever it returns here (§3).
   */
  criteria?: Criterion[];
}

export interface SynthesizeInput {
  task: PlannedTask;
  envelope: Envelope;
  toolCatalogue: string[];
  /**
   * The transports that actually exist, which is a smaller set than §7's table
   * describes. Passed in for the same reason the envelope is: the registry is the
   * authority on what a synthesized agent may run on, and §7 says that decision "is
   * not left to the planner's judgment". Without it a model reads the table, picks
   * `agent-sdk`, and the task dies at dispatch instead of at validation.
   */
  transports: string[];
  /**
   * The agent CLIs a `cli` or `acp` spec may target, narrowed to what this machine can
   * start and to whatever harness the human pinned at compose time.
   *
   * The same argument as `transports`, one field along, and it was the half still
   * missing: `SYNTHESIZE_PROMPT` named "claude or codex" in prose, so a machine with
   * only `codex` installed still invited a spec targeting `claude` — defect 21 exactly,
   * discovered at dispatch rather than at validation.
   */
  targets: string[];
  /**
   * The model names a spec may name, or **empty for unconstrained**.
   *
   * `AgentSpec.model` is a required non-empty string that reaches `--model` on a real
   * CLI, and until this existed nothing checked it at all: an invented name passed
   * validation, was written into the log, and failed at dispatch with the task already
   * planned and staffed. Narrowed further by whatever the human pinned — see
   * `workers/harness.ts` `allowedModels`.
   *
   * Empty means nothing is *known*, never that nothing is allowed: no list of `codex`
   * models has been verified, and refusing every one of them to enforce the Anthropic
   * half would be the confident wrong answer (§9.5's rule, applied to a menu).
   */
  models: string[];
  /**
   * The roles this mission may staff from, already rendered to one line each by
   * `agents/offer.ts` — the documented roster plus anything a human has promoted
   * (§6, §7).
   *
   * A **rendered string** rather than a list of objects, and that is the whole
   * mechanism rather than a formatting choice. `describe()` JSON-dumps whatever it is
   * given straight into the prompt, so a list of role objects would carry every role's
   * body — some six hundred lines — into a call that needs to read eighteen
   * descriptions. Rendering at the seam makes the expensive half unreachable from
   * here by construction.
   *
   * What comes back is validated exactly as an unprompted spec is: the envelope, the
   * transport registry, and the lease rule all still apply, and naming a role grants
   * nothing. Absent when the roster is empty or switched off.
   */
  roster?: string;
  /**
   * The verified model cards this machine can reach, rendered one line each by
   * `providers/modelCard.ts` — id, tier, context window, and the two rates
   * (PLAN-NEXT 2.4).
   *
   * A **rendered string** for `roster`'s reason: `describe()` JSON-dumps whatever it is
   * given, and a list of card objects would spend context on field names the model does
   * not have to read. Budgeted by `MODEL_CARD_INDEX_BUDGET` at the same seam.
   *
   * It is a menu, not a grant. `models` is still the allowlist a spec is checked
   * against, and a card names a model at some provider's API rather than one this
   * harness is known to accept — see `staffingOffer`. Absent when no provider has been
   * probed on this machine, which is every machine until one is configured.
   */
  modelCards?: string;
  /** Present only on the one retry, quoting what was wrong with the last spec. */
  rejected?: string;
}

export interface ProgressInput {
  criteria: Criterion[];
  /** This round's reports — the entire evidence base, since there is no transcript. */
  reports: { taskId: string; report: WorkerReport }[];
  /** The last few progress ledgers, which is how `isInLoop` is answerable at all. */
  recentProgress: ProgressLedger[];
  counters: { round: number; stalls: number; resets: number };
  /**
   * Tasks that can never become ready because a dependency failed (§3). The
   * scheduler does not cancel them; naming them here is what turns "nothing happened
   * this round" into a blocking task the replan can act on.
   */
  frontier: { taskId: string; blockedBy: string[] }[];
  /**
   * What a human said since the last round, undelivered (§10).
   *
   * Present here and not only in the ledger because a note is meant to change the
   * *next decision*, and the progress call is where the next decision is made. It
   * also lands in `factsGiven`, which is what makes it survive a replan — the two
   * are not redundant: one steers this round, the other outlives it.
   */
  notes?: string[];
}

export interface JudgeInput {
  criterion: Criterion;
  check: Extract<VerifySpec, { kind: "judge" }>;
  /** Artifacts, not reports: a judge fed the worker's own summary is grading the
   *  thing it is grading. */
  artifactPaths: string[];
  /**
   * Which seat of a panel this call is, by lens (PLAN-NEXT 6.1) — `PANEL_LENSES`.
   *
   * Absent is the whole of a quick mission's panel and every task-level check, and it
   * has to stay absent rather than defaulting to a lens: `judgeSystemPrompt` hands back
   * the unmodified `JUDGE_PROMPT` for it, which is what makes "quick judge spend
   * unchanged" a property of the code rather than a hope about token counts.
   */
  lens?: string;
}

export interface JudgeResult {
  met: boolean;
  evidence: Evidence;
}

export interface Calls {
  research(input: ResearchInput): Promise<ResearchResult>;
  /** Turns findings into the outcome spec and a design note (PLAN-NEXT 5.1). Skipped on
   *  a quick mission exactly as the deep research pass is — the scan's own criteria are
   *  the spec there, and `solePass` is what tells it so. */
  architect(input: ArchitectInput): Promise<ArchitectResult>;
  /** Returns questions; it never asks them. Who does the asking, and the cap on how
   *  many get through, are both above this seam (`loop/intake.ts`). */
  intake(input: IntakeInput): Promise<IntakeResult>;
  plan(input: PlanInput): Promise<PlanResult>;
  /** Attacks the breakdown before it is validated (PLAN-NEXT 5.3). It returns objections
   *  and never a plan: what to do about one is the planner's, which is the same division
   *  `judge` has with the worker it grades. */
  critique(input: CritiqueInput): Promise<CritiqueResult>;
  synthesize(input: SynthesizeInput): Promise<AgentSpec>;
  progress(input: ProgressInput): Promise<ProgressLedger>;
  judge(input: JudgeInput): Promise<JudgeResult>;
}
