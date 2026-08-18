// The `HumanPort` for a terminal. The web shell (§13) implements the same interface.
//
// This exists rather than waiting for the shell because the terminal is a supported
// mode forever, not scaffolding (§2b): headless and CI runs are real, and `--plan-only`
// is the CI gate. It is also what makes 3a's sequence testable end to end before a
// single line of the server exists — the reading of a line is injected, so the whole
// port runs against a scripted transcript with no tty.
//
// One deliberate omission: there is no "approve all" and no remembered answer. A gate
// a human taps through without reading is the failure mode §11 spends a whole
// rehearsal design avoiding, and sign-off is the one screen where the reading is the
// entire value.
import readline from "node:readline/promises";
import { LIMITS } from "../domain/mission.js";
import { type HumanPort, type IntakeAnswer, type SignoffPresentation } from "../loop/human.js";
import { type IntakeQuestion } from "../loop/calls.js";
import { type PermissionAsk } from "../workers/acp/permissionPort.js";
import { renderSignoff } from "./render.js";
import { type Io } from "./main.js";

/**
 * One line in, injected so the port is testable without a tty.
 *
 * `undefined` means the input ended — a closed pipe, a redirect that ran out, a
 * process with no terminal. It is distinct from `""`, which is a human pressing
 * Enter, and the two must not be confused: Enter is a decision to skip a question,
 * and end-of-input is the discovery that nobody is there to decide anything.
 */
export interface Prompter {
  ask(prompt: string): Promise<string | undefined>;
  close(): void;
}

/** What `awaitSignoff` throws when the input ends before anyone approved. */
export class NoOneAtTheKeyboardError extends Error {
  constructor() {
    super(
      "Sign-off needs an answer and standard input ended without one. Run this " +
        "attached to a terminal, or start the mission with --unattended --force if " +
        "you mean to skip reading the plan.",
    );
    this.name = "NoOneAtTheKeyboardError";
  }
}

/** What `askPermission` throws when the input ends with a worker still waiting. It is
 *  not a denial: another surface may still answer, and only a person may widen a grant
 *  (§7). */
export class NoOneToAskError extends Error {
  constructor(tool: string) {
    super(
      `A running agent asked to use '${tool}' and standard input ended without an ` +
        "answer. Approve or refuse it from the dashboard, or run the mission attached " +
        "to a terminal.",
    );
    this.name = "NoOneToAskError";
  }
}

/**
 * Opens stdin on the first question and not before.
 *
 * Lazily, because a readline interface holds the event loop open: constructing one up
 * front would make `orchestra run --unattended` — the mode with nobody at the
 * keyboard — hang after the mission finished, waiting on input no one is going to
 * type. A mission that asks nothing never touches stdin at all.
 */
export function createStdinPrompter(): Prompter {
  let rl: readline.Interface | undefined;
  let ended = false;

  return {
    async ask(prompt) {
      if (ended) return undefined;

      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      const iface = rl;

      // Raced against the interface closing, because `question` on an input that has
      // already ended never settles — the process then exits with the mission
      // half-asked and nothing in the log saying why.
      const controller = new AbortController();
      const closed = new Promise<undefined>((resolve) => {
        iface.once("close", () => {
          ended = true;
          controller.abort();
          resolve(undefined);
        });
      });

      try {
        return await Promise.race([iface.question(prompt, { signal: controller.signal }), closed]);
      } catch {
        ended = true;
        return undefined;
      }
    },
    close: () => rl?.close(),
  };
}

/** Answers from a script, in order; running out is end-of-input, not a blank line.
 *  Used by tests and by nothing else. */
export function scriptedPrompter(answers: readonly string[]): Prompter {
  let index = 0;
  return {
    ask: async () => answers[index++],
    close: () => {},
  };
}

export function createTerminalHuman(io: Io, prompter: Prompter): HumanPort {
  return {
    async askIntake(questions: readonly IntakeQuestion[]): Promise<IntakeAnswer[]> {
      io.out("");
      io.out(`A few questions before this is planned (${questions.length}):`);

      const answers: IntakeAnswer[] = [];
      for (const [index, question] of questions.entries()) {
        io.out("");
        io.out(`  ${index + 1}. ${question.question}`);
        if (question.options) io.out(`     options: ${question.options.join(" / ")}`);

        const reply = await prompter.ask("     > ");

        // Input ended. Which of two things that means depends on whether anything
        // was answered first, and the distinction decides whether the dashboard ever
        // gets a turn: these ports race (`anyOf`), so a terminal that cheerfully
        // returns "no answers" on a machine with no tty *wins* that race and the
        // browser is never asked. Nothing answered means nobody is here — say so and
        // let another surface take it. Something answered means a real person
        // stopped, and what they gave stands.
        if (reply === undefined) {
          if (index === 0) throw new NoOneAtTheKeyboardError();
          break;
        }

        // Enter skips, and that is a different thing from the line above.
        const answer = reply.trim();
        if (answer !== "") answers.push({ questionId: question.id, answer });
      }

      return answers;
    },

    async requestExtension(request) {
      io.out("");
      io.out(`── ${request.missionId} · out of budget ${"─".repeat(24)}`);
      io.out(
        `  spent ${Math.round(request.spentWallMs / 60_000)} min of ` +
          `${Math.round(request.budget.wallMs / 60_000)} · extension ` +
          `${request.extensionsUsed + 1} of ${LIMITS.maxExtensions}`,
      );
      io.out(
        request.unmetCriteria.length > 0
          ? `  still outstanding: ${request.unmetCriteria.join(", ")}`
          : "  every criterion is met; the loop has not confirmed it yet",
      );

      const reply = await prompter.ask("minutes to add, or Enter to stop here: ");
      // End of input declines, and declining abandons with the artifacts intact
      // (§9.4). Silence must not buy more time.
      if (reply === undefined) return undefined;

      const minutes = Number(reply.trim());
      if (!Number.isFinite(minutes) || minutes <= 0) return undefined;

      return { wallMs: request.budget.wallMs + minutes * 60_000 };
    },

    async askPermission(request: PermissionAsk): Promise<boolean> {
      io.out("");
      io.out(`── ${request.taskId} · asks to use ${request.tool} ${"─".repeat(20)}`);
      if (request.detail) io.out(`  ${request.detail}`);
      io.out("  It was not granted this at synthesis, so only you can allow it (§7).");

      for (;;) {
        const line = await prompter.ask("allow this once? [y/n] ");

        // End of input is not an allow, and it is not a deny either. These ports race
        // (`anyOf`), and a terminal that answered for the human on a machine with no
        // tty would win that race and the dashboard would never be shown the request.
        // Raising is what lets another surface take it; the worker keeps waiting, and
        // the ACP session's own timeout is what bounds that.
        if (line === undefined) throw new NoOneToAskError(request.tool);

        const reply = line.trim().toLowerCase();
        if (/^(y|yes|a|allow)$/.test(reply)) return true;
        if (/^(n|no|d|deny)$/.test(reply)) return false;

        // Nothing defaults. A grant taken by leaning on Enter is exactly the widening
        // §7 reserves for a person.
        io.out("  Type 'y' to allow this one call, or 'n' to refuse it.");
      }
    },

    async awaitSignoff(presentation: SignoffPresentation) {
      // One screen, two things it can be asking about (§13): a fresh plan, or a
      // replan asking to edit a signed-off criterion. Same port, same race, same
      // end-of-input rule — only the wording changes, because "revise" and "reject"
      // are the same decision from the loop's side and different words to a human.
      const change = presentation.proposedChange !== undefined;

      io.out("");
      io.out(
        change
          ? `── ${presentation.missionId} · a replan wants to change the contract ${"─".repeat(8)}`
          : `── ${presentation.missionId} · awaiting your approval ${"─".repeat(20)}`,
      );
      io.out(presentation.goal);
      if (presentation.brief) {
        io.out("");
        io.out(presentation.brief);
      }
      io.out("");
      for (const line of renderSignoff(presentation)) io.out(line);

      io.out("");
      // Looping rather than defaulting: approving a plan by pressing Enter at the
      // wrong moment is exactly the reflex this screen exists to interrupt.
      for (;;) {
        const line = await prompter.ask(
          change
            ? "approve the change, or type a reason to reject it: "
            : "approve, or type feedback to revise: ",
        );

        // End of input is not approval, and this is the one place that distinction
        // has teeth. Skipping sign-off is a decision a human makes with a flag (§17);
        // inferring it from a closed pipe would hand the whole guarantee away to a
        // shell redirect. The mission stays `awaiting_signoff` and is approvable on
        // the next run.
        if (line === undefined) throw new NoOneAtTheKeyboardError();

        const reply = line.trim();
        if (/^(a|approve|y|yes)$/i.test(reply)) return { kind: "approve" };
        if (reply !== "") return { kind: "revise", feedback: reply };

        io.out(
          change
            ? "  Type 'approve' to accept the new contract, or say why it should stand."
            : "  Type 'approve' to start work, or say what should change.",
        );
      }
    },
  };
}
