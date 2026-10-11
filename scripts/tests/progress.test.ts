// scripts/tests/progress.test.ts
//
// What a run says while it is still working.
//
// The defect these assert against is not a crash. `bun run dev` printed nothing
// between the command line and the first line the Supabase CLI happened to emit —
// which is seconds on a warm machine and minutes on a cold one, and a silent
// terminal is indistinguishable from a hung one. Every test here is one of the
// ways that silence can come back, named by what the reader would experience.
//
// Time is injected rather than waited for: an assertion about elapsed output that
// sleeps is an assertion about how long the machine took, not about what the code
// says. The one real-process test is bounded by its own supervisor's timeout, so a
// regression fails instead of hanging the lane.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/shared/paths.ts';
import {
  createProgress,
  failureReason,
  formatElapsed,
  type ProgressClock,
  type ProgressStream,
  reportStep,
} from '../src/shared/progress.ts';
import { runBoundedSync } from '../src/shared/run_bounded.ts';

const ERASE = '\r\u001b[2K';

/** A stream that keeps every write, so an assertion can read the bytes. */
const recordingStream = (options: { tty?: boolean; columns?: number } = {}) => {
  const chunks: string[] = [];
  const stream = {
    chunks,
    isTTY: options.tty ?? false,
    columns: options.columns ?? 80,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
  return {
    stream,
    chunks,
    text: (): string => chunks.join(''),
    /** Lines a terminal would have committed, with the live line's repaints removed. */
    lines: (): string[] =>
      chunks
        .filter((chunk) => chunk.includes('\n'))
        .join('')
        .split('\n')
        .filter((line) => line.length > 0),
  };
};

/** A clock the test decides the time on. */
const fakeClock = () => {
  let now = 0;
  let ticks: (() => void)[] = [];
  return {
    clock: {
      now: () => now,
      every: (_ms: number, tick: () => void) => {
        ticks.push(tick);
        return () => {
          ticks = ticks.filter((candidate) => candidate !== tick);
        };
      },
    } satisfies ProgressClock,
    /** Move time on and deliver one redraw, the way a real interval would. */
    advance: (ms: number): void => {
      now += ms;
      for (const tick of [...ticks]) {
        tick();
      }
    },
    ticking: (): boolean => ticks.length > 0,
  };
};

describe('a slow step says what it is before it does anything', () => {
  test('the label is on the terminal while the work is still running', () => {
    const out = recordingStream();
    const progress = createProgress({ stream: out.stream, environment: {} });

    // No `done`. This is the state the developer is looking at during the minute
    // `supabase start` takes: the only moment the output could have been given.
    progress.step('starting the local containers');

    expect(out.text()).toContain('starting the local containers');
  });

  test('a pipe gets the same words, with no escape sequences to mangle a log', () => {
    const out = recordingStream({ tty: false });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('replaying migrations');
    time.advance(3000);
    step.done();

    // CI reads this. An animation is unreadable there, and control codes in a log
    // are a corruption of it — so the animation goes and the words stay.
    expect(out.lines().join('\n')).toBe('  -> replaying migrations\n  ✓ replaying migrations 3s');
    expect(out.text()).not.toContain('\u001b');
  });

  test('an 80-column terminal shows the whole step, not a fragment of it', () => {
    const out = recordingStream({ tty: true, columns: 80 });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('supabase -> building the finite runner image');
    time.advance(1000);
    step.done();

    // The budget is measured in visible characters. Counting the escape bytes that
    // paint the elapsed time took nine columns off every line, which on this step
    // left `supabase -> building the…` — a name that says nothing and looks like
    // a rendering bug.
    const committed = out.lines()[0] ?? '';
    expect(committed).toContain('building the finite runner image');
    expect(committed).not.toContain('…');
  });

  test('a terminal that reports no width shows a usable line rather than nothing', () => {
    // `columns: 0` is what a pty with no window size reports, and budgeting
    // against it produced a one-word line.
    const out = recordingStream({ tty: true, columns: 0 });
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });

    progress.step('waiting for stripe-mock to answer').done();
    expect(out.lines()[0]).toContain('stripe-mock');
  });

  test('the elapsed time is reported, because "it finished" is not the question', () => {
    const out = recordingStream();
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('building the finite runner image');
    time.advance(2 * 60 * 1000 + 5000);
    step.done();

    expect(out.text()).toContain('2m 05s');
  });
});

describe('a terminal shows one moving line, not a line per frame', () => {
  test('redrawing replaces the line instead of scrolling a new one', () => {
    const out = recordingStream({ tty: true });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('waiting for stripe-mock to answer');
    for (let frame = 0; frame < 30; frame += 1) {
      time.advance(90);
    }
    step.done();

    // Thirty frames, one committed line. A progress indicator that scrolls is a
    // scrollback full of noise and the step buried in the middle of it.
    const redraws = out.chunks.filter((chunk) => chunk.startsWith('\r'));
    expect(redraws.length).toBeGreaterThan(1);
    expect(redraws.every((chunk) => !chunk.includes('\n'))).toBe(true);
    expect(out.lines()).toHaveLength(1);
    expect(out.lines()[0]).toContain('waiting for stripe-mock to answer');
  });

  test('a step that ends leaves the next one visible, and the last one settled', () => {
    const out = recordingStream({ tty: true });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    // Nesting is a service's own step under the service, not one service under
    // another — `services start together` below is the test for that distinction.
    const service = progress.service('supabase');
    const containers = service.step('starting the local containers');
    time.advance(1000);
    containers.done();
    // The child is done but the service is not: the line the developer is watching
    // has to say so, or the run looks finished while it is still starting.
    expect(out.chunks.at(-1)).toContain('supabase');
    time.advance(1000);
    service.done();

    expect(out.text()).toContain('supabase -> starting the local containers');
    expect(out.lines().filter((line) => line.includes('✓'))).toHaveLength(2);
  });
});

describe('output from somewhere else is not spliced into the line', () => {
  test('a foreign write lands above the live line and the line comes back', () => {
    const out = recordingStream({ tty: true });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('starting the local containers');
    time.advance(500);
    // What the Supabase CLI's captured output does the moment it is printed.
    out.stream.write('Starting database...\n');
    step.done();

    const at = out.chunks.findIndex((chunk) => chunk.includes('Starting database...'));
    expect(out.chunks[at - 1]).toBe(ERASE);
    // Redrawn below it, so the next frame continues where the reader left off.
    expect(out.chunks[at + 1]?.startsWith('\r')).toBe(true);
  });

  test('a foreign write that has not finished its line keeps the cursor', () => {
    const out = recordingStream({ tty: true });
    const time = fakeClock();
    const progress = createProgress({ stream: out.stream, environment: {}, clock: time.clock });

    const step = progress.step('replaying migrations');
    const before = out.chunks.length;
    // A chunk boundary in the middle of somebody's line. Drawing here would put a
    // spinner into the text they are still writing.
    out.stream.write('Applying migration 202610070001_prof');
    expect(out.chunks.length).toBe(before + 2);
    step.done();
  });

  test('the stream is handed back unchanged once the run is over', () => {
    const out = recordingStream({ tty: true });
    const original = out.stream.write;
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });

    progress.step('seeding the demo account').done();
    progress.stop();

    // This is the one global side effect in the workspace, and it exists only
    // while a step is live. If it outlived the run, every later write in the
    // process would pass through a function whose reason for existing had ended.
    expect(out.stream.write).toBe(original);
  });
});

describe('a failure is named, and named in one line', () => {
  test('the step that failed is named with the reason, and the error still propagates', async () => {
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });
    const failure = new Error('Supabase local start failed with exit 1.');

    await expect(
      reportStep(progress, 'starting the local containers', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(out.text()).toContain('✗ starting the local containers');
    expect(out.text()).toContain('Supabase local start failed with exit 1.');
  });

  test('a refusal keeps its remedy on the indicator, and one line of it at that', async () => {
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });
    const refusal = new Error(
      'The container local service needs a container engine to build the finite runner image, which this host does not have.\n  Install Docker Engine or Podman.',
    );

    await expect(
      reportStep(progress, 'container', async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    // Whoever fails prints the whole refusal, remedy included. An indicator that
    // printed it too would wrap into four lines and stop being an indicator.
    const indicator = out.lines().find((line) => line.includes('✗')) ?? '';
    expect(indicator).toContain('needs a container engine to build the finite runner image');
    expect(indicator).not.toContain('Install Docker Engine or Podman');
  });

  test('an error with no message still names a reason', () => {
    expect(failureReason(new Error(''))).toBe('failed without a message');
    expect(failureReason('plain string')).toBe('plain string');
  });
});

describe('a step reports what it produced', () => {
  test('a reused image and a built one do not read the same line', async () => {
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });
    const image = (reused: boolean) => ({ reused, rustTests: reused ? -1 : 7 });

    await reportStep(
      progress,
      'building the finite runner image',
      async () => image(true),
      (built) =>
        built.reused
          ? 'reused: already built from these sources'
          : `${built.rustTests} Rust tests passed`,
    );
    await reportStep(
      progress,
      'building the finite runner image',
      async () => image(false),
      (built) =>
        built.reused
          ? 'reused: already built from these sources'
          : `${built.rustTests} Rust tests passed`,
    );

    // "The image is ready" and "the image was already there" lead to opposite
    // conclusions about whether the sources are what ran, so the line must not
    // collapse them into one.
    expect(out.text()).toContain('reused: already built from these sources');
    expect(out.text()).toContain('7 Rust tests passed');
  });
});

describe('services start together, so steps belong to one service', () => {
  test('two services are peers, and neither nests under the other', () => {
    // Services start concurrently now, so `supabase` is still live when `stripe`
    // is announced. Nesting under "whatever is running" printed
    // `supabase -> stripe`, which reads as though Stripe were a step of the database
    // and names neither correctly.
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });

    const supabase = progress.service('supabase');
    const stripe = progress.service('stripe');
    supabase.step('starting the local containers');
    stripe.step('checking the credentials');
    stripe.done();
    supabase.done();

    const printed = out.lines().join('\n');
    expect(printed).not.toContain('supabase -> stripe');
    expect(printed).toContain('supabase -> starting the local containers');
    expect(printed).toContain('stripe -> checking the credentials');
  });

  test('a committed step keeps the service it belongs to', () => {
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });

    // The owner has to be found before the entry leaves its scope. Searching after
    // the splice finds nothing, and the committed line reads
    // `checking the credentials` — with no service named, in a run that has four.
    progress.service('stripe').step('checking the credentials').done();

    // The committed line, not the `-> stripe` announcement that precedes it.
    const committed = out.lines().find((line) => line.includes('checking the credentials')) ?? '';
    expect(committed).toContain('stripe -> checking the credentials');
  });

  test('a service is reported once, not as a step under the run', () => {
    const out = recordingStream();
    const progress = createProgress({
      stream: out.stream,
      environment: {},
      clock: fakeClock().clock,
    });

    progress.service('supabase').done();

    expect(out.lines()[0]).toContain('supabase');
    expect(out.lines()[0]).not.toContain('supabase -> supabase');
  });
});

describe('an indicator must never be the reason a command does not exit', () => {
  test('a step left unfinished does not hold the process open', () => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, '..', 'src', 'shared', 'progress.ts'),
    ).href;
    // A real process, announcing a step and never finishing it — the shape of the
    // defect: the work is done, the timer is not. A referenced interval here would
    // leave the process spinning forever, which is why the supervisor bounds it
    // and the assertion is on its exit code rather than on a sleep.
    const result = runBoundedSync({
      command: process.execPath,
      args: [
        '-e',
        `const { createProgress } = await import(${JSON.stringify(moduleUrl)});
         createProgress({
           stream: { write: (text) => process.stdout.write(text), isTTY: true, columns: 80 },
           environment: {},
         }).step('never finished');
         process.exitCode = 0;`,
      ],
      cwd: REPO_ROOT,
      timeoutMs: 20_000,
      maxBytes: 256_000,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('time budget');
    expect(result.stderr).not.toContain('Supervisor failed');
  });
});

describe('elapsed time reads as a duration rather than as a number', () => {
  test('seconds below a minute, minutes above it, hours above those', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(59_600)).toBe('1m 00s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m');
  });
});

describe('the reporter does not touch anything it was not asked about', () => {
  test('a step begun after a stop still works, and stopping twice is safe', () => {
    const out = recordingStream({ tty: true });
    const progress = createProgress({
      stream: out.stream as ProgressStream,
      environment: {},
      clock: fakeClock().clock,
    });

    progress.stop();
    progress.step('seeding the demo account').done();
    progress.stop();

    // `stop` is called from error paths, and an error path can be reached twice.
    // A reporter that threw here would replace the failure the caller was
    // reporting with a failure about the reporter.
    expect(out.text()).toContain('seeding the demo account');
  });
});
