// What happens when a decision point does not answer at all (§9.4, defect 36).
//
// The five model calls are the one part of the loop that reaches outside the process,
// and they fail the way anything on a network fails: a throttled account, a CLI that
// exits without a result message, a call that comes back with no JSON in it after its
// one reformat attempt. Until this file existed, every one of those escaped `runLoop`
// as an exception, unwound through `executeMission` and `main`, and killed the run
// process — taking with it a mission whose worktrees, commits, and ledger were all
// intact on disk. A real mission died that way on its first round.
//
// §9.4 has an answer for every other failure in the system and it applies here
// unchanged: a transport error is retried with backoff, and running out of ways to
// continue is a question rather than a crash. So this wraps `Calls` with the retry,
// and turns whatever is left into a typed error the loop can *park* on. A parked
// mission is one `orchestra resume` away from carrying on; a dead process is a mission
// a human has to reconstruct.
//
// Two failures, deliberately told apart:
//
//   A `CallFormatError` has already had its retry. `agentCalls.ts` asks once, quotes
//   the rejection, and asks again — a third attempt at the same schema against the same
//   model is spending the mission's budget to learn the same thing.
//
//   Everything else is transport-shaped and has not been tried twice: the call never
//   reached a model, or reached one that was rate-limited. That is exactly §9.4's
//   "retry same agent, exponential backoff, maxAttempts 2".
import { CALL_NAMES } from "../domain/budget.js";
import { CallFormatError } from "./agentCalls.js";
import { type Calls } from "./calls.js";

/**
 * A decision point that could not answer, after whatever retries it was owed.
 *
 * Typed rather than a bare `Error` so the loop can tell it from a programming mistake:
 * an unparseable answer parks the mission, and a `TypeError` in the reducer must still
 * raise. Catching everything would turn the second into the first, and a bug that
 * silently parks is a bug nobody finds.
 */
export class DecisionPointError extends Error {
  readonly call: keyof Calls;
  readonly attempts: number;

  constructor(call: keyof Calls, attempts: number, cause: Error) {
    super(
      `The '${call}' decision point failed after ${attempts} attempt(s): ${cause.message}`,
      { cause },
    );
    this.name = "DecisionPointError";
    this.call = call;
    this.attempts = attempts;
  }
}

/**
 * Whether trying the same call again could plausibly produce a different answer.
 *
 * Pure, and separate from the wrapper, because this is the whole judgment: retrying a
 * schema the model has already failed twice costs money and teaches nothing, while
 * *not* retrying a 429 abandons a mission over a minute of throttling.
 */
export function isRetriable(error: unknown): boolean {
  return !(error instanceof CallFormatError);
}

export interface ResilientCallsDeps {
  /** Total attempts per call, including the first. §9.4's `maxAttempts` for a
   *  transport error is 2, and that is the default here for the same reason. */
  attempts?: number;
  /** The first backoff; each further attempt doubles it. */
  backoffMs?: number;
  /** Injected so the retry is testable without spending the delay. */
  sleep?(ms: number): Promise<void>;
  onWarn?(message: string): void;
}

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 5_000;

/**
 * `Calls`, with §9.4's retry in front of it and a typed failure behind it.
 *
 * Applied at the composition root rather than inside `agentCalls.ts`, so the loop's
 * own tests can script a call that throws and assert the mission parks — the failure
 * mode stays above the seam even though its cause never is. The wrapper is generic
 * over the interface's own keys rather than a method per call, because a decision point
 * added to `Calls` and forgotten here would be a call with no retry and no park, which is
 * the defect this file closes coming back.
 *
 * The names come from `domain/budget.ts` and this file kept its own copy of them until
 * PLAN-NEXT 5 — which is how `architect` was wrapped everywhere except here and arrived
 * at the composition root as `undefined`. One list; `loop/calls.test.ts` pins it to
 * `keyof Calls`.
 */
export function resilientCalls(calls: Calls, deps: ResilientCallsDeps = {}): Calls {
  const attempts = Math.max(1, deps.attempts ?? DEFAULT_ATTEMPTS);
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const wrapped = {} as Record<keyof Calls, (input: never) => Promise<unknown>>;

  for (const name of CALL_NAMES) {
    wrapped[name] = async (input: never) => {
      let last: Error | undefined;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await (calls[name] as (arg: never) => Promise<unknown>)(input);
        } catch (error) {
          last = error as Error;
          if (!isRetriable(error) || attempt === attempts) break;

          const waitMs = backoff * 2 ** (attempt - 1);
          deps.onWarn?.(
            `The '${name}' decision point failed (${last.message}). ` +
              `Retrying in ${Math.round(waitMs / 1000)}s — attempt ${attempt + 1} of ${attempts}.`,
          );
          await sleep(waitMs);
        }
      }

      throw new DecisionPointError(name, attemptsMade(last, attempts), last!);
    };
  }

  return wrapped as unknown as Calls;
}

/** A format error stops after one attempt; anything else used the full allowance. */
const attemptsMade = (error: Error | undefined, attempts: number): number =>
  isRetriable(error) ? attempts : 1;
