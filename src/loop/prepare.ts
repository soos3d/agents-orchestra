// Everything before the first worker runs: scan, intake, research, the outcome spec,
// the plan, and the estimate that makes sign-off a decision rather than a formality
// (§2b, §5).
//
// This is where `--plan-only` stops. It earns its place three times over: it exercises
// research and planning for a fraction of a real run, it is the natural CI mode
// ("does this mission still plan sensibly?"), and it is how the loop gets developed
// without paying for a fan-out on every iteration.
//
// The order is the point, and an earlier draft had it backwards. Scanning before
// asking is what makes the three questions worth blocking for: asked blind they come
// back as "what does done look like?", which the human answered by writing the brief.
// Asked over what the scan found, they can name the two test commands the repo has.
// So: scan (silent, cheap, never blocks), then intake, then research over what is
// still open, then the spec, then sign-off.
import { type OfferedRole } from "../agents/offer.js";
import { zeroSpend } from "../domain/budget.js";
import {
  type Criterion,
  type Fact,
  type Finding,
  type Guess,
  type PlannedTask,
} from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type EventInput } from "../events/schema.js";
import { type Recall } from "../memory/lore.js";
import { recallToLedger } from "../memory/recall.js";
import { validatePlan } from "../scheduler/validate.js";
import { type Calls } from "./calls.js";
import { estimatePlan } from "./estimate.js";
import { unattendedHuman, type HumanPort, type SignoffPresentation } from "./human.js";
import { runIntake } from "./intake.js";
import { writeOutcomeSpec, type SpecRejection } from "./outcomeSpec.js";
import {
  buildArchitectInput,
  buildCritiqueInput,
  buildPlanInput,
  buildResearchInput,
  designSummary,
} from "./prompts.js";
import { redact, type Secret } from "../workers/redact.js";
import { type MissionStore } from "./run.js";
import { SynthesisError, synthesizeTasks } from "./synthesize.js";

/** How many times `revise` may send the plan back before the mission gives up.
 *  A human who has revised three times is describing a different mission. */
export const MAX_SIGNOFF_REVISIONS = 3;

export interface PrepareDeps {
  store: MissionStore;
  calls: Calls;
  /** Stop after the estimate. No agent is synthesized and no worker runs. */
  planOnly?: boolean;
  unattended?: boolean;
  /**
   * Semantic memory, as a closure rather than a directory (§6).
   *
   * Search before you research, so knowledge accretes instead of duplicating (§5) —
   * but prepare never touches disk, so the composition root binds `readLore` to the
   * lore directory and hands the result in. Absent means this machine has no memory
   * layer, which is a supported mode and not a broken one.
   */
  recall?: () => Recall;
  /** Procedural memory (§6, §7): agents a human promoted from earlier missions, handed
   *  to synthesis as prior art. Bound at the composition root like `recall`, and for
   *  the same reason — prepare never touches disk. */
  roles?: readonly OfferedRole[];
  /** The transports synthesis may pick on this machine (§7), narrowed from what the
   *  build ships by what was probed on PATH. Bound at the composition root like
   *  `recall` and `roles`, and for the same reason: prepare probes nothing. */
  transports?: readonly string[];
  /** Absent means nobody is there, which is what `--unattended` amounts to. */
  human?: HumanPort;
  /**
   * Where the architect's design note goes, as a closure rather than a directory
   * (PLAN-NEXT 5.1) — `recall`'s shape, for `recall`'s reason: prepare never touches
   * disk, so the composition root binds this to the mission's artifact root and hands
   * back the absolute path it wrote.
   *
   * Best-effort by design, like `keepEvidence`: it returns `undefined` when there is
   * nowhere to write or the write failed, and a mission that cannot save a design note
   * still plans. What is lost then is the note, not the criteria — the architect's other
   * answer went through `writeOutcomeSpec` and is on the log either way.
   */
  writeDesign?(note: string): string | undefined;
  /**
   * The specialist scanners this mission may use as a criterion's check (PLAN-NEXT 6.3).
   *
   * Bound at the composition root like `roles` and `transports`, and for their reason:
   * prepare probes nothing. It is already the intersection of what the envelope granted
   * and what this machine answered for (`availableScanners`), so what arrives here is
   * runnable — the architect is offered exactly this list and `writeOutcomeSpec` refuses
   * anything outside it. Absent is every mission until a human grants one.
   */
  scanners?: readonly string[];
  /**
   * The granted variables this machine holds a value for (PLAN-NEXT 7.3), so the prepare
   * phase is inside the scrub rather than in front of it.
   *
   * `buildLoopDeps` derives this list for the loop, and the loop runs *after* prepare —
   * which left `research_completed`, `design_written` and the design note itself as the
   * three surfaces written before any scrubber existed. Research and the architect are
   * calls with tools against the repository, so a granted value sitting in a file there
   * (a `.env` a previous round wrote, a fixture, the hardcoded credential a scanner is
   * about to flag) can be quoted into a design note that every code worker's prompt then
   * names by path. Bound at the composition root like `writeDesign` and empty on every
   * mission that granted nothing, which makes the scrub an identity.
   */
  secrets?: readonly Secret[];
  onWarn?(message: string): void;
}

export type PrepareResult =
  | { ok: true; criteria: Criterion[]; plan: PlannedTask[]; estimate: Estimate; brief: string }
  | { ok: false; reason: string; rejected?: SpecRejection[] };

export async function prepareMission(deps: PrepareDeps): Promise<PrepareResult> {
  const missionId = deps.store.state().mission.id;
  const base = { missionId, actor: "orchestrator" as const };
  const emit = (event: EventInput) => deps.store.emit(event);
  const at = new Date().toISOString();

  const move = (to: Parameters<typeof missionStatus>[0], reason: string) =>
    emit({ ...base, ...missionStatus(to, deps.store.state().mission.status, reason) });

  const human = deps.human ?? unattendedHuman();

  // Memory first, then research (§5, §6). Ahead of the scan rather than beside it,
  // so what the store already knows is in the ledger before anything is paid for —
  // and so the scan's own facts are numbered off a ledger that already holds it.
  if (deps.recall) {
    const { fresh, stale } = deps.recall();
    const consulted = fresh.length + stale.length;
    if (consulted > 0) {
      const recalled = recallToLedger(fresh, stale, at);
      emit({ ...base, type: "memory_recalled", ...recalled, consulted });
    }
  }

  // Scan (§2b): one cheap pass, silent, never blocks. It exists to make intake's
  // questions specific rather than to answer them, so its findings land in the ledger
  // before a single question is asked.
  const scan = await deps.calls.research(buildResearchInput(deps.store.state(), "scan"));
  emit({ ...base, type: "scan_completed", findings: scan.findings, spend: zeroSpend() });

  const beforeScan = deps.store.state().mission.ledger;
  const scanned = appendFacts(beforeScan.factsVerified, scan.findings, at);
  if (scanned.length > beforeScan.factsVerified.length) {
    emit({
      ...base,
      type: "ledger_revised",
      ledger: { ...beforeScan, factsVerified: scanned },
      reason: "research",
    });
  }

  move("intake", "scan complete");
  const given = await runIntake({
    store: deps.store,
    calls: deps.calls,
    human,
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
  });

  if (given.length > 0) {
    const ledger = deps.store.state().mission.ledger;
    emit({
      ...base,
      type: "ledger_revised",
      // Appended, never replaced. `factsGiven` is append-only across replans (§3),
      // and starting that tier off by overwriting it would be an odd precedent.
      ledger: { ...ledger, factsGiven: [...ledger.factsGiven, ...given] },
      reason: "intake",
    });
  }

  move("researching", "intake complete");

  // The human's own judgment at compose time that this job is small (the compose
  // checkbox, `--quick`). Read from the fold rather than taken as a parameter, which
  // is what makes it survive a resume: a mission carried on the next morning keeps the
  // shape it was started with, and no caller has to remember to pass it twice.
  //
  // What it buys is this call. The scan (§2b) already ran, already returned a brief
  // and criteria, and both were being discarded — so on a small job the deep pass is a
  // second research call over ground the first one covered. What it does *not* buy is
  // any relaxation of the gate below.
  // …with one exception, and it is structural rather than cautious. The scan runs
  // *before* intake and the deep call after (§2b's ordering, which is what makes the
  // questions specific). So reusing the scan's criteria means the outcome spec was
  // written by a call that never saw the human's answers — a mission asked "calendar
  // or fiscal?" and told "fiscal" would be judged against criteria settled before
  // anyone knew. An answered question is exactly the evidence that the job had
  // something in it worth researching, so it buys the deep call back.
  //
  // Answers, not questions: `--unattended` asks and is told nothing, and there is no
  // answer there for the scan to have missed.
  const answered = given.length > 0;
  const quick = deps.store.state().mission.quick && !answered;

  if (deps.store.state().mission.quick && answered) {
    deps.onWarn?.(
      "This mission was composed as quick, but intake was answered — researching in " +
        "full so the outcome spec is written knowing the answers.",
    );
  }

  // On a quick mission this is the scan's own answer, kept instead of thrown away.
  // The event is emitted either way, and carries a brief either way, because
  // `briefing.ts` marks the research stage done on `view.brief !== ""` — a quick
  // mission that emitted nothing here would leave that row pulsing above stages that
  // had already finished.
  let research = quick ? scan : await deps.calls.research(buildResearchInput(deps.store.state()));
  emit({
    ...base,
    type: "research_completed",
    brief: redact(research.brief, deps.secrets ?? []),
    findings: research.findings.map((finding) => ({
      ...finding,
      claim: redact(finding.claim, deps.secrets ?? []),
    })),
    depth: quick ? ("scan" as const) : ("deep" as const),
    spend: zeroSpend(),
  });

  move("specifying", "research complete");

  // The architect (PLAN-NEXT 5.1), and the whole of what `quick` skips here. A quick
  // mission's spec is the scan's own criteria, exactly as it was before this call
  // existed — `solePass` is what makes that answer load-bearing, and it is untouched.
  // So a quick mission pays for no architect, no design note, and no critic, and its
  // token count is what it was.
  const designed = quick
    ? undefined
    : await deps.calls.architect(
        buildArchitectInput(deps.store.state(), research.findings, undefined, deps.scanners),
      );

  if (designed) recordDesign(deps, base, designed.designNote);
  if (designed) raiseSecrets(deps, base, designed.envVars);

  // One retry, the same allowance every structured return gets. A second would let a
  // model that cannot write a checkable criterion spend the mission's budget on it.
  const authored = designed ?? research;
  let spec = writeOutcomeSpec(authored.criteria ?? [], deps.scanners);
  // Merged rather than taken from the architect alone, for the reason memory's guesses
  // are merged below: research labels what it could not source, the architect labels
  // what the design leaves open, and neither call can see the other's list. Assigning
  // one over the other drops exactly the entries the sign-off screen exists to show.
  let guesses = mergeGuesses(research.guesses ?? [], authored.guesses ?? []);
  let outOfScope = authored.outOfScope ?? research.outOfScope ?? [];

  if (!spec.ok) {
    emit({ ...base, type: "outcome_spec_rejected", rejected: spec.rejected });

    // Whoever wrote the refused spec is who gets the retry, quoting the gate's verdict.
    // On a quick mission that is the deep research call and it is an escalation: the
    // checkbox said the job was small and the outcome spec says otherwise, so the
    // mission buys back the research it skipped rather than asking the scan the same
    // question twice. A wrong checkbox costs one call, not a run.
    const second = quick
      ? await deps.calls.research(
          buildResearchInput(deps.store.state(), "deep", describeRejections(spec.rejected)),
        )
      : await deps.calls.architect(
          buildArchitectInput(
            deps.store.state(),
            research.findings,
            describeRejections(spec.rejected),
            deps.scanners,
          ),
        );

    spec = writeOutcomeSpec(second.criteria ?? [], deps.scanners);
    guesses = mergeGuesses(guesses, second.guesses ?? []);
    outOfScope = second.outOfScope ?? outOfScope;
    // A second architect answer carries a second design note, and the mission's note has
    // to be the one that belongs to the criteria that were accepted.
    if ("designNote" in second) recordDesign(deps, base, second.designNote);
    if ("envVars" in second) raiseSecrets(deps, base, second.envVars);
    // The deep answer replaces the scan's for everything downstream — the findings it
    // appends to the ledger below, and the brief the sign-off screen shows.
    if (quick && "brief" in second) research = second;

    if (!spec.ok) {
      emit({ ...base, type: "outcome_spec_rejected", rejected: spec.rejected });
      return {
        ok: false,
        rejected: spec.rejected,
        reason:
          `The outcome spec was rejected twice. A criterion the runtime cannot evaluate ` +
          `means this mission could never legitimately report success.`,
      };
    }
  }

  // Criteria enter the ledger before planning, because they are an input to it: the
  // planner needs to know what it is being asked to satisfy. The scan's facts are
  // already there, so research appends rather than replacing — overwriting would drop
  // exactly the findings the intake questions were built on.
  const existing = deps.store.state().mission.ledger;
  // Merged rather than assigned, for the same reason the facts are appended: a stale
  // memory entered as a guess (§6) and the research call knows nothing about it, so
  // assigning here would silently drop the one entry the sign-off screen most needs
  // to show — a fact nobody re-checked.
  const allGuesses = mergeGuesses(existing.guesses, guesses);
  const ledgerWithSpec = {
    ...existing,
    factsVerified: appendFacts(existing.factsVerified, research.findings, at),
    criteria: spec.criteria,
    guesses: allGuesses,
  };
  emit({ ...base, type: "ledger_revised", ledger: ledgerWithSpec, reason: "spec" });

  const planned = await planWithOneRetry(deps);
  if ("message" in planned) return { ok: false, reason: planned.message };

  const estimate = estimatePlan({ plan: planned.tasks });
  emit({
    ...base,
    type: "ledger_revised",
    ledger: { ...ledgerWithSpec, plan: planned.tasks },
    reason: "replan",
  });
  emit({
    ...base,
    type: "outcome_spec_written",
    criteria: spec.criteria,
    guesses: allGuesses,
    outOfScope,
    estimate,
  });
  emit({ ...base, type: "signoff_requested", estimate });

  const result: PrepareResult = {
    ok: true,
    criteria: spec.criteria,
    plan: planned.tasks,
    estimate,
    brief: research.brief,
  };

  if (deps.planOnly) return result;

  const signedOff = await presentAndSignOff({ ...deps, human });
  return signedOff.ok ? { ...result, plan: signedOff.plan, estimate: signedOff.estimate } : signedOff;
}

export interface PresentDeps {
  store: MissionStore;
  calls: Calls;
  human: HumanPort;
  /** Prior art for synthesis (§7) — sign-off is where the approved plan is staffed,
   *  so this path needs them as much as the replan inside the loop does. */
  roles?: readonly OfferedRole[];
  /** And the machine's transports for the same reason: sign-off staffs the approved
   *  plan, so an offer wired only into the loop is wired into the wrong half. */
  transports?: readonly string[];
  unattended?: boolean;
}

export type SignoffOutcome =
  | { ok: true; plan: PlannedTask[]; estimate: Estimate }
  | { ok: false; reason: string };

/**
 * Present the plan, take the decision, and replan on feedback until it is approved.
 *
 * Split out from `prepareMission` because sign-off has two entry points and only one
 * of them starts from a fresh plan. `orchestra run` arrives here having just planned;
 * `orchestra resume` arrives at a mission that has been sitting `awaiting_signoff`
 * since last night, with nothing in memory. If the two had separate implementations,
 * the resumed one would be the one nobody exercised, and it is the one that matters —
 * the whole point of the state surviving a restart is that the approval still works.
 *
 * So everything here is read from folded state rather than passed in. That is also
 * what lets the web shell render the same screen from the log alone.
 */
export async function presentAndSignOff(deps: PresentDeps): Promise<SignoffOutcome> {
  const base = { missionId: deps.store.state().mission.id, actor: "orchestrator" as const };
  const emit = (event: EventInput) => deps.store.emit(event);

  const move = (to: Parameters<typeof missionStatus>[0], reason: string) =>
    emit({ ...base, ...missionStatus(to, deps.store.state().mission.status, reason) });

  // Moved before the await, and that ordering is the feature: the process can die on
  // the next line and the log already says what it was waiting for.
  if (deps.store.state().mission.status !== "awaiting_signoff") {
    move("awaiting_signoff", "the plan is ready for a human");
  }

  for (let revision = 0; ; revision++) {
    const state = deps.store.state();
    const { mission } = state;
    const estimate =
      mission.estimate ??
      estimatePlan({ plan: mission.ledger.plan });

    const decision = await deps.human.awaitSignoff({
      missionId: mission.id,
      goal: mission.goal,
      brief: state.brief,
      criteria: mission.ledger.criteria,
      guesses: mission.ledger.guesses,
      outOfScope: state.outOfScope,
      envelope: mission.capabilityEnvelope,
      plan: mission.ledger.plan,
      estimate,
    });

    if (decision.kind === "approve") {
      // Synthesis can refuse the approved plan — an unbuilt transport, a capability
      // outside the envelope, a code task that would not name its files (§7, §8). The
      // mission has already been parked by `grantSignoff`; this turns the throw into
      // an exit code and a message rather than a stack trace over an approval the
      // human just gave.
      try {
        await grantSignoff(deps, mission.ledger.plan);
      } catch (error) {
        if (!(error instanceof SynthesisError)) throw error;
        return { ok: false, reason: error.message };
      }
      return { ok: true, plan: mission.ledger.plan, estimate };
    }

    emit({ ...base, type: "signoff_revised", feedback: decision.feedback });

    if (revision + 1 >= MAX_SIGNOFF_REVISIONS) {
      return {
        ok: false,
        reason:
          `The plan was sent back ${MAX_SIGNOFF_REVISIONS} times without being approved. ` +
          `Start a mission whose goal says what the feedback has been asking for.`,
      };
    }

    move("specifying", "revising the plan on feedback");

    // A quick mission sent back is the human contradicting their own checkbox: they
    // said the job was small and the plan they were shown says otherwise. Replanning
    // over scan-depth findings would answer that with the same thin ground twice, so
    // the first revision buys back the research the mission skipped.
    //
    // Findings only, deliberately. The criteria are still unfrozen here (sign-off has
    // not happened), but the objection was to the *plan* — rewriting the contract
    // under a human who was complaining about the work is not what they asked for.
    //
    // `revision === 0` rather than a folded flag: it is the first send-back that is
    // worth a call, and a mission resumed at its own sign-off starting the count again
    // costs one research call, which is the right side of that trade to be wrong on.
    if (revision === 0 && mission.quick) {
      const deep = await deps.calls.research(buildResearchInput(deps.store.state()));
      const ledger = deps.store.state().mission.ledger;
      const at = new Date().toISOString();
      emit({
        ...base,
        type: "research_completed",
        brief: deep.brief,
        findings: deep.findings,
        depth: "deep",
        spend: zeroSpend(),
      });
      emit({
        ...base,
        type: "ledger_revised",
        ledger: { ...ledger, factsVerified: appendFacts(ledger.factsVerified, deep.findings, at) },
        reason: "research",
      });
    }

    const replanned = await planWithOneRetry(deps, decision.feedback);
    if ("message" in replanned) return { ok: false, reason: replanned.message };

    const revised = estimatePlan({ plan: replanned.tasks });

    emit({
      ...base,
      type: "ledger_revised",
      ledger: { ...deps.store.state().mission.ledger, plan: replanned.tasks },
      reason: "replan",
    });
    // Re-emitted so the estimate on the screen matches the plan on the screen. The
    // criteria are unchanged and still unfrozen — sign-off has not happened yet, which
    // is the only reason rewriting them here is legal (§3).
    emit({
      ...base,
      type: "outcome_spec_written",
      criteria: mission.ledger.criteria,
      guesses: mission.ledger.guesses,
      outOfScope: state.outOfScope,
      estimate: revised,
    });
    emit({ ...base, type: "signoff_requested", estimate: revised });
    move("awaiting_signoff", "the revised plan is ready for a human");
  }
}

export interface SignoffDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  roles?: readonly OfferedRole[];
  transports?: readonly string[];
  unattended?: boolean;
}

/**
 * Approves a plan and turns it into work: the sign-off event, an agent per task, and
 * the move to `executing`.
 *
 * Phase 2 approves its own sign-off and records that it did; Phase 3 replaces the
 * decision with the screen and emits exactly this. The event being the same either
 * way is why the criteria freeze already works — `revise` reads `signedOffAt`, not
 * who set it.
 *
 * `resume` on a `--plan-only` mission also lands here, because typing the command is
 * the approval (§13). One emitter, so there is one moment criteria freeze at.
 */
export async function grantSignoff(
  deps: SignoffDeps,
  plan: readonly PlannedTask[],
): Promise<void> {
  const state = deps.store.state();
  const base = { missionId: state.mission.id, actor: "orchestrator" as const };

  deps.store.emit({ ...base, type: "signoff_granted", unattended: deps.unattended ?? false });

  // The mission status is this function's to own, so the park happens here and the
  // rethrow lets the caller decide the exit code. A synthesis failure after sign-off
  // leaves the mission neither `awaiting_signoff` nor `executing`, and saying nothing
  // would leave it in the first — approvable again, against a plan that cannot be
  // staffed.
  try {
    await synthesizeTasks(deps, plan, 0);
  } catch (error) {
    if (error instanceof SynthesisError) {
      deps.store.emit({
        ...base,
        type: "mission_status",
        from: deps.store.state().mission.status,
        to: "blocked",
        reason: error.message,
      });
    }
    throw error;
  }

  deps.store.emit({
    ...base,
    type: "mission_status",
    from: deps.store.state().mission.status,
    to: "executing",
    reason: "signed off",
  });
}

/**
 * The design note on disk, and the event that says where.
 *
 * The write is best-effort and the event follows it rather than preceding it: a
 * `design_written` naming a file nobody wrote would put a path into a worker's prompt
 * that the worker cannot open, which is defect 40's shape one layer up. No write, no
 * event, and the mission plans without a design note exactly as a quick one does.
 */
function recordDesign(
  deps: PrepareDeps,
  base: { missionId: string; actor: "orchestrator" },
  raw: string,
): void {
  // Scrubbed before the write, not after: the note is a file a code worker's prompt names
  // by absolute path, so a value quoted into it would be read back into every worker that
  // opens it — one write site is what keeps the file, the event's summary and the
  // projection saying the same thing.
  const note = redact(raw, deps.secrets ?? []);
  const path = deps.writeDesign?.(note);
  if (!path) {
    deps.onWarn?.(
      "The architect's design note could not be written, so no worker will be given its " +
        "path. The outcome spec is unaffected.",
    );
    return;
  }
  deps.store.emit({ ...base, type: "design_written", path, summary: designSummary(note) });
}

/**
 * Credentials the design needs that nobody granted (PLAN-NEXT 7.1).
 *
 * Three things about this and each is a decision. **The mission does not stop.** A run
 * that parks at 2am on a key nobody is awake to grant has paid for research and
 * planning to produce nothing, and the architect has already been told to design
 * against mocks — so the question is raised and the plan carries on, which is what
 * "a mission never blocks on a missing API key" means.
 *
 * **It goes through `question_asked` and no second inbox.** The fold already parks,
 * resolves and survives a restart for that event; a private channel here would be a
 * question that only a running loop could answer, and the answer to this one usually
 * arrives hours later. `blocks` is empty because there is no task yet to park — the
 * plan does not exist when the architect answers.
 *
 * **Nothing here widens the envelope**, for the reason `synthesize.ts` gives when it
 * raises the same kind of question: widening is a human decision and there is no code
 * path that makes it. The human's half is `orchestra run --env NAME`, which the
 * question names.
 */
function raiseSecrets(
  deps: PrepareDeps,
  base: { missionId: string; actor: "orchestrator" },
  requested: readonly string[] | undefined,
): void {
  const state = deps.store.state();
  const granted = new Set(state.mission.capabilityEnvelope.env);
  const already = new Set(state.secretsRequired);
  // Deduped against what this mission already raised, so the architect's one retry does
  // not open a second inbox item for the same variable.
  const names = [...new Set(requested ?? [])].filter(
    (name) => !granted.has(name) && !already.has(name),
  );
  if (names.length === 0) return;

  deps.store.emit({ ...base, type: "secret_required", names });
  deps.store.emit({
    ...base,
    type: "question_asked",
    questionId: `secret-${names.join("+")}`,
    question:
      `The design needs ${names.join(", ")}, which this mission's envelope does not ` +
      `grant. It is being planned against mocks, so it will finish either way. To run ` +
      `the real integration, start it again with ${names.map((name) => `--env ${name}`).join(" ")} ` +
      `— that grants the name and the value is read from this machine's environment, ` +
      `never from here.`,
    blocks: [],
    // Nothing waits on this one, and saying so on the event is what keeps a later resume
    // from waiting on it anyway (PLAN-NEXT 7.2): `blocks: []` alone cannot be told apart
    // from a reset-cap escalation whose tasks are all done.
    advisory: true,
  });
}

/**
 * The plan critic (PLAN-NEXT 5.3): one attack on the breakdown, and at most one replan.
 *
 * Capped at one on purpose — a critic that can keep objecting is a budget leak, and the
 * second objection to a plan is not worth what the third plan costs. Skipped on a quick
 * mission for the architect's reason: the human said the job was small, and a
 * one-task plan has no dependency to miss and no lease to collide with.
 */
async function critiquedPlan(
  deps: PrepareDeps,
  first: Awaited<ReturnType<Calls["plan"]>>,
  asked: string | undefined,
): Promise<Awaited<ReturnType<Calls["plan"]>>> {
  if (deps.store.state().mission.quick) return first;

  const { objections } = await deps.calls.critique(
    buildCritiqueInput(deps.store.state(), first.tasks),
  );

  const base = { missionId: deps.store.state().mission.id, actor: "orchestrator" as const };
  if (objections.length === 0) return first;

  deps.store.emit({ ...base, type: "plan_critiqued", objections, replanned: true });

  const complaint = objections
    .map((objection) => `${objection.taskId ? `${objection.taskId}: ` : ""}${objection.kind} — ${objection.detail}`)
    .join("\n");

  return deps.calls.plan(
    buildPlanInput(
      deps.store.state(),
      `${asked ? `${asked}\n\n` : ""}A review of the last plan raised these objections. ` +
        `Fix each one and return the whole plan:\n${complaint}`,
    ),
  );
}

/** One structured-return retry, quoting the offending edge. A plan that cannot be
 *  scheduled produces a mission that runs to its reset cap having dispatched nothing
 *  (§3), so this is checked before a single agent is synthesized. */
async function planWithOneRetry(
  deps: PrepareDeps,
  feedback?: string,
): Promise<Awaited<ReturnType<Calls["plan"]>> | { message: string }> {
  const asked = feedback === undefined ? undefined : `The human sent the last plan back: ${feedback}`;

  // The criteria are in the ledger before planning starts — they are an input to it —
  // so a plan that satisfies none of them is refusable here, before sign-off shows a
  // human a plan that could never complete the mission (defect 32).
  const criteria = () => deps.store.state().mission.ledger.criteria;

  // The critic runs between the plan and its validation (PLAN-NEXT 5.3), which is the
  // one place a colliding lease or an ungradeable criterion is still cheap: after
  // validation the plan is on its way to a human, and after sign-off it is on its way to
  // a worktree.
  const first = await critiquedPlan(deps, await deps.calls.plan(buildPlanInput(deps.store.state(), asked)), asked);
  const check = validatePlan(first.tasks, criteria());
  if (check.ok) return first;

  const second = await deps.calls.plan(
    buildPlanInput(deps.store.state(), `The last plan was rejected: ${check.message}`),
  );
  const recheck = validatePlan(second.tasks, criteria());
  return recheck.ok
    ? second
    : { message: `The planner could not produce a runnable plan: ${recheck.message}` };
}

/**
 * The refusals, as one line each, for the retry to answer.
 *
 * Quoted rather than summarized: `SpecRejection.criterion` is the statement the model
 * itself wrote, so naming it back is what lets the retry tell which of five criteria
 * is the problem — the same reason `validatePlan`'s message quotes the offending edge.
 */
const describeRejections = (rejected: readonly SpecRejection[]): string =>
  rejected.map((entry) => `"${entry.criterion}" — ${entry.reason}`).join("\n");

/**
 * Findings become verified facts, appended to what is already there.
 *
 * Appended rather than assigned because two calls produce them now — the scan and
 * then research — and the ids have to stay unique across both: `motivatedBy` names a
 * fact by id (§4.2), so a second `f1` makes "why does this task exist" answer with
 * the wrong fact. §6's provenance rule is already enforced by `findingSchema`, which
 * rejects an empty source at the boundary.
 *
 * A finding already on record is dropped rather than duplicated. Research is told
 * what is still open, but it is not forbidden from confirming something the scan
 * found, and the same claim twice is noise in every prompt built afterwards.
 */
export function appendFacts(
  existing: readonly Fact[],
  findings: readonly Finding[],
  at: string,
): Fact[] {
  const seen = new Set(existing.map((fact) => `${fact.text} ${fact.source.ref}`));
  const taken = new Set(existing.map((fact) => fact.id));
  const facts = [...existing];
  let next = 1;

  for (const finding of findings) {
    const key = `${finding.claim} ${finding.source}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // The next free `f<n>` rather than the array's length, because memory recalls its
    // own entries into this list first (§6). Off the length, a ledger already holding
    // one recalled fact would start numbering at `f2`, and a later revision that
    // dropped it would hand `f2` out twice — and `motivatedBy` names a fact by id
    // (§4.2), so a reused id points a task's provenance at the wrong thing.
    while (taken.has(`f${next}`)) next++;
    const id = `f${next}`;
    taken.add(id);

    facts.push({
      id,
      text: finding.claim,
      addedRound: 0,
      source: { kind: sourceKind(finding.sourceKind), ref: finding.source },
      observedAt: at,
    });
  }

  return facts;
}

/**
 * Guesses from two sources, kept apart by id.
 *
 * Memory contributes stale facts as guesses before research runs (§6), and the
 * research call knows nothing about them — so assigning its list over the ledger's
 * would drop the one entry the sign-off screen most needs to show, a fact nobody
 * re-checked. A research guess reusing an id is the more recent judgment and wins;
 * everything else is kept.
 */
export function mergeGuesses(existing: readonly Guess[], incoming: readonly Guess[]): Guess[] {
  const restated = new Set(incoming.map((guess) => guess.id));
  return [...existing.filter((guess) => !restated.has(guess.id)), ...incoming];
}

const sourceKind = (kind: Finding["sourceKind"]): Fact["source"]["kind"] =>
  kind === "memory" ? "memory" : "research";

function missionStatus(
  to: "intake" | "researching" | "specifying" | "awaiting_signoff",
  from: ReturnType<MissionStore["state"]>["mission"]["status"],
  reason: string,
) {
  return { type: "mission_status" as const, from, to, reason };
}
