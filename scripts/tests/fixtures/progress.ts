// scripts/tests/fixtures/progress.ts
//
// A reporter that remembers what it was told, for tests whose subject is that a
// run *said* something, and said it to the right thing.
//
// Two scopes on purpose, because they nest differently. A *service* entry is
// top-level — `supabase` and `stripe` are peers starting at the same time, and
// neither is a step of the other. A step inside a service nests under that
// service only. A test asserting `stripe -> running the stripe-mock container`
// proves the nesting is scoped to the service that did the work, which is the whole
// point once services start concurrently and "the innermost live step" is ambiguous.
//
// Deliberately not the real reporter. These tests are about *which* steps a caller
// announced and in what order; the drawing, the erasing and the elapsed-time
// wording are asserted in `progress.test.ts` against a stream that records bytes.

import type { Progress, ServiceProgress, Stepper } from '../../src/shared/progress.ts';

export interface RecordedStep {
  /** The service this step belongs to, or null for a step on the run itself. */
  readonly service: string | null;
  /** What the reader sees: the service and the step chain, joined. */
  readonly chain: string;
  readonly outcome: 'done' | 'failed';
  /** What the caller passed: a count, or the reason it failed. */
  readonly note: string | undefined;
}

export interface RecordingProgress {
  readonly progress: Progress;
  /** Every chain announced, in the order announced, including the still-live ones. */
  readonly announced: () => string[];
  readonly steps: RecordedStep[];
  /** Chains still running — what a viewer would be able to see right now. */
  readonly live: () => string[];
}

interface Open {
  readonly service: string | null;
  readonly chain: string;
}

/**
 * Collect what `work` wrote to stderr, and put the stream back.
 *
 * Its own fixture because the code under test writes refusals with
 * `process.stderr.write` — the module-level global — rather than through any
 * injectable logger, so a test that wants to read them has to intercept the real
 * thing. Always restored, including on a throw: a leaked patch would silently
 * swallow every later failure message in the file.
 */
export const captureStderr = async (work: () => Promise<void>): Promise<string[]> => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(String(chunk)).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await work();
  } finally {
    process.stderr.write = original;
  }
  return written;
};

export const recordingProgress = (): RecordingProgress => {
  const steps: RecordedStep[] = [];
  const announced: string[] = [];
  const open: Open[] = [];

  const settle = (entry: Open, outcome: 'done' | 'failed', note: string | undefined): void => {
    const index = open.indexOf(entry);
    if (index >= 0) {
      open.splice(index, 1);
    }
    steps.push({ service: entry.service, chain: entry.chain, outcome, note });
  };

  const begin = (service: string | null, label: string) => {
    // Nest only inside a service, under that service's most recent unfinished step.
    // A step on the run itself is top-level: services start concurrently, so
    // nesting one under another would print `supabase -> stripe`, naming neither.
    const parent =
      service === null
        ? undefined
        : [...open].reverse().find((candidate) => candidate.service === service);
    // Flattened from a nested ternary, which Biome forbids. Same three cases, same
    // order: no service means the label alone, otherwise the parent chain if there
    // is one and `service -> label` if there is not.
    let chain = label;
    if (service !== null) {
      chain = parent === undefined ? `${service} -> ${label}` : `${parent.chain} -> ${label}`;
    }
    const entry: Open = { service, chain };
    announced.push(chain);
    open.push(entry);
    return {
      done: (outcome?: string) => {
        settle(entry, 'done', outcome);
      },
      fail: (reason: string) => {
        settle(entry, 'failed', reason);
      },
    };
  };

  const scoped = (service: string | null): Stepper => ({
    step: (label: string) => begin(service, label),
  });

  return {
    steps,
    announced: () => [...announced],
    live: () => open.map((entry) => entry.chain),
    progress: {
      ...scoped(null),
      service: (label: string): ServiceProgress => {
        const serviceEntry = begin(null, label);
        return {
          ...scoped(label),
          done: (outcome?: string) => {
            serviceEntry.done(outcome);
          },
          fail: (reason: string) => {
            serviceEntry.fail(reason);
          },
        };
      },
      stop: () => {
        open.length = 0;
      },
    },
  };
};
