// scripts/src/shared/prompt.ts
//
// One question, asked on a terminal.
//
// Line-based rather than a raw-mode arrow-key picker, for three reasons that all
// point the same way: it works over `ssh` and in a `docker exec` without a TTY of
// its own, it is testable by parsing a string instead of by synthesising key
// events, and the answer it produces is *the same syntax as the flag*, so a
// developer who answers the prompt once knows how to script the next run. An
// arrow-key menu teaches nothing you can paste.
//
// Refuses when there is no interactive terminal. A prompt that cannot ask must
// not guess: reading a closed stdin returns EOF immediately, and treating that as
// "yes" would start a container build in CI because nobody was there to say no.

import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export interface Choice<T extends string> {
  readonly id: T;
  /** Left column. */
  readonly label: string;
  /** Right column: what this actually does. */
  readonly detail: string;
}

/** True when this process can ask a question and read an answer. */
export const canAsk = (
  environment: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadStream = processStdin,
): boolean => input.isTTY === true && environment.CI !== 'true';

/**
 * Render the menu. Pure, so what a developer is offered is assertable.
 *
 * The numbering is one-based because it is what the answer is typed as, so a
 * mismatch between the printed index and the parsed index is the kind of bug that
 * selects the wrong stack while looking like it worked.
 */
export const renderChoices = <T extends string>(
  title: string,
  choices: readonly Choice<T>[],
): string =>
  [
    title,
    ...choices.map((choice, index) => `  ${index + 1}) ${choice.label}  ${choice.detail}`),
    '',
    'Enter a number, several numbers or names separated by commas. Ctrl-C to cancel.',
  ].join('\n');

/**
 * Parse an answer into the chosen ids.
 *
 * Accepts `2`, `1,3`, `supabase,stripe` and `1,stripe` together, because a
 * developer halfway through typing should not be punished for switching notation.
 * Returns a refusal naming the unrecognised tokens rather than dropping them: a
 * silently-ignored token is a stack that starts fewer services than asked for and
 * says nothing.
 */
export const parseAnswer = <T extends string>(
  answer: string,
  choices: readonly Choice<T>[],
): { ok: true; ids: T[] } | { ok: false; unknown: string[] } => {
  const byIndex = new Map(choices.map((choice, index) => [String(index + 1), choice.id]));
  const chosen = new Set<T>();

  for (const token of answer.split(',').map((part) => part.trim().toLowerCase())) {
    if (token.length === 0) {
      continue;
    }
    const byNumber = byIndex.get(token);
    if (byNumber !== undefined) {
      chosen.add(byNumber);
      continue;
    }
    const byId = choices.find((choice) => choice.id === token);
    if (byId !== undefined) {
      chosen.add(byId.id);
      continue;
    }
    return { ok: false, unknown: [token] };
  }

  if (chosen.size === 0) {
    return { ok: false, unknown: [] };
  }
  return { ok: true, ids: choices.filter((choice) => chosen.has(choice.id)).map((c) => c.id) };
};

/** Ask once, re-rendering on a bad answer until it is understood or cancelled. */
export const askOnce = async <T extends string>(
  title: string,
  choices: readonly Choice<T>[],
): Promise<T[] | null> => {
  const rl = createInterface({ input: processStdin, output: processStdout });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      processStdout.write(`\n${renderChoices(title, choices)}\n> `);
      const answer = (await rl.question('')).trim();
      if (answer.length === 0) {
        return null;
      }
      const parsed = parseAnswer(answer, choices);
      if (parsed.ok) {
        return parsed.ids;
      }
      if (parsed.unknown.length === 0) {
        processStdout.write('Nothing was selected. Press Ctrl-C to cancel.\n');
        continue;
      }
      processStdout.write(
        `Not an option: ${parsed.unknown.join(', ')}. Choose from: ${choices
          .map((choice, index) => `${index + 1}=${choice.id}`)
          .join(', ')}\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
};
