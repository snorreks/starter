// scripts/tests/prompt.test.ts
//
// The interactive stack menu.
//
// The parse is pure and asserted here; the terminal is not. What matters is that
// the answer a developer gives produces the same set as the flag they would
// otherwise have typed — a menu that accepts `2` and a `--stack` that accepts
// `stripe` must mean the same thing.

import { describe, expect, test } from 'bun:test';
import { stackChoices } from '../src/dev-stack.ts';
import { type Choice, canAsk, parseAnswer, renderChoices } from '../src/shared/prompt.ts';

const CHOICES: Choice<string>[] = [
  { id: 'client', label: 'client   ', detail: 'a local database and the app' },
  { id: 'stripe', label: 'stripe   ', detail: 'adds stripe-mock' },
  { id: 'full', label: 'full     ', detail: 'everything' },
];

describe('the menu numbers what it will accept', () => {
  test('the printed index is one-based and matches the parsed index', () => {
    const rendered = renderChoices('What should this run start?', CHOICES);
    // An off-by-one here selects the wrong stack while looking like it worked,
    // so the rendered text itself is asserted rather than assumed.
    expect(rendered).toContain('  1) client');
    expect(rendered).toContain('  2) stripe');
    expect(parseAnswer('1', CHOICES)).toEqual({ ok: true, ids: ['client'] });
    expect(parseAnswer('2', CHOICES)).toEqual({ ok: true, ids: ['stripe'] });
  });
});

describe('an answer is read the same way the flag is written', () => {
  test('a name and a number mean the same thing', () => {
    expect(parseAnswer('stripe', CHOICES)).toEqual(parseAnswer('2', CHOICES));
  });

  test('numbers and names can be mixed', () => {
    // A developer halfway through typing should not be punished for switching
    // notation, and the result must be the flag's spelling so they can paste it.
    expect(parseAnswer('1,full', CHOICES)).toEqual({ ok: true, ids: ['client', 'full'] });
  });

  test('repeats and surrounding whitespace collapse', () => {
    expect(parseAnswer(' stripe , stripe ', CHOICES)).toEqual({ ok: true, ids: ['stripe'] });
  });

  test('an unrecognised answer is refused and named, never silently dropped', () => {
    // Dropping it would start fewer services than were asked for and report
    // success, which is the outcome this repository refuses most strongly.
    const parsed = parseAnswer('client,stirpe', CHOICES);
    expect(parsed).toEqual({ ok: false, unknown: ['stirpe'] });
  });

  test('an empty answer is not a selection', () => {
    expect(parseAnswer('', CHOICES)).toEqual({ ok: false, unknown: [] });
    expect(parseAnswer(' , ', CHOICES)).toEqual({ ok: false, unknown: [] });
  });
});

describe('a run that cannot ask does not guess', () => {
  test('no terminal, or CI, means the prompt is unavailable', () => {
    const noTty = { isTTY: false } as NodeJS.ReadStream;
    const tty = { isTTY: true } as NodeJS.ReadStream;
    // A prompt that cannot ask must refuse. Reading a closed stdin returns EOF
    // immediately, and treating that as consent would start a container build in
    // CI because nobody was there to say no.
    expect(canAsk({}, noTty)).toBe(false);
    expect(canAsk({ CI: 'true' }, tty)).toBe(false);
    expect(canAsk({}, tty)).toBe(true);
  });
});

describe('the menu offers every stack with a reason', () => {
  test('each offered stack names the services it starts and what that means', () => {
    // A stack that exists but is not offered is invisible, which is how a feature
    // ships and nobody can find it.
    const choices = stackChoices();
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.services.length).toBeGreaterThan(0);
      expect(choice.detail.length).toBeGreaterThan(0);
    }
  });
});
