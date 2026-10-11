// scripts/src/shared/progress.ts
//
// Saying what a slow run is doing, while it is still doing it.
//
// **The failure this exists to prevent.** `bun run dev` printed nothing at all
// between the command line and the first line the Supabase CLI happened to emit.
// On a warm machine that is a second or two. On a cold one `supabase start` pulls
// images and boots eight containers, and `--stack container` runs cargo inside a
// Docker build for minutes. A terminal that says nothing for minutes is
// indistinguishable from a hung command, and the reaction to a hung command is
// Ctrl-C — so the run is killed by the only thing that was slow. Silence is not
// neutral here; it costs the developer the run and the diagnosis.
//
// **A step is announced before it runs, and reported when it ends.** An indicator
// that appears after the fact is not an indicator. So the first thing a step does
// is write its name, and the thing after that is its elapsed time.
//
// **A terminal and a pipe both get words; only a terminal gets motion.** The
// spinner is a terminal affordance. The portable output is one line per step,
// which is what CI, a `| tee`, and a bug report need — a job that hangs with
// nothing in its log is the same defect in a different place. The two modes differ
// in animation, never in whether they speak.
//
// **Steps belong to a service, not to "whatever is running".** Services start
// concurrently, so "the innermost live step" is ambiguous: with two services up at
// once, nesting under the most recent one prints `supabase -> stripe`, which names
// neither. Each service therefore gets its own scope, and a step nests only inside
// its own. One line is still drawn at a time — a terminal cannot show two — but it
// follows whichever service most recently did something, and when that service
// finishes, the next live one takes the line.
//
// **The reporter owns one line, and gives it up when it must.** Other modules
// write to stdout while steps run: the Supabase CLI's output is captured and
// arrives as one block, the dev server's own stream arrives as chunks, the port
// allocator announces a fallback. Splicing those into a spinner produces output
// nobody can read, so a foreign write erases the live line, lands, and the line is
// redrawn under it. That is the one global side effect in the tooling workspace,
// it exists only while a step is live, and it is removed the moment the last step
// ends.
//
// **An indicator must never be the reason a command does not exit.** The redraw
// timer is unreferenced so it cannot hold the event loop open, and `stop()` exists
// for the caller that is about to return.
//
// Nothing here formats a *value*. A step carries a label a developer wrote or a
// repository declares, which is why a credential cannot reach this module by
// accident: the credentials are in the summary lines the services print after the
// run has finished, and those are built elsewhere.

import { stdout as processStdout } from 'node:process';

/** How often a live step is redrawn. Fast enough to read as motion, slow enough to be free. */
export const FRAME_MS = 90;

/** Below this width the label is cut rather than wrapped onto a second line. */
const MIN_COLUMNS = 24;

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** `TERM=dumb` gets these: a terminal that cannot draw a braille glyph can still show progress. */
const ASCII_FRAMES = ['-', '\\', '|', '/'];

const DIM = '2';
const GREEN = '32';
const RED = '31';

/** The stream shape the reporter needs, so a test can hand it a recording one. */
export interface ProgressStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
}

/**
 * Time and timers, injected.
 *
 * Injected rather than reached for directly because "it showed progress" is a
 * statement about elapsed time, and the only honest way to assert one is to
 * decide what the elapsed time is. `scripts/tests/progress.test.ts` drives this
 * clock instead of sleeping.
 */
export interface ProgressClock {
  /** Milliseconds. Only differences are meaningful. */
  now(): number;
  /** Run `tick` every `ms`; the returned function stops it. */
  every: (ms: number, tick: () => void) => () => void;
}

export const systemClock: ProgressClock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    // Unreferenced, deliberately. This timer exists to redraw a line; if it also
    // kept the event loop alive, a command that finished its work would sit here
    // forever instead of exiting with its exit code. That is the one outcome an
    // indicator must not produce.
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  },
};

/** One unit of work that has been announced and not yet finished. */
export interface ProgressStep {
  /** It finished. `outcome` is a short note about what it produced. */
  done: (outcome?: string) => void;
  /** It failed. The reason is written before the caller's own failure report. */
  fail: (reason: string) => void;
}

/**
 * Anything that can start a step.
 *
 * Both the whole run and one service satisfy it, which is what lets
 * {@link reportStep} be used at either level: a service's own steps are reported
 * through its scope, and the service itself is reported through the run.
 */
export interface Stepper {
  step: (label: string) => ProgressStep;
}

/**
 * One service's steps.
 *
 * The scope is what makes concurrent starts legible: `starting the local
 * containers` belongs to `supabase` and is labelled as such, rather than being
 * nested under whichever service happened to be drawn last.
 */
export interface ServiceProgress extends Stepper {
  /** The whole service is up. */
  done: (outcome?: string) => void;
  /** The whole service failed. */
  fail: (reason: string) => void;
}

export interface Progress extends Stepper {
  /**
   * Declare a service and get the reporter its own steps report through.
   *
   * Services start concurrently, so this is what keeps `stripe`'s steps off
   * `supabase`'s line.
   */
  service: (label: string) => ServiceProgress;
  /**
   * Finish every live line and stop redrawing.
   *
   * For the caller returning from a run. Steps are normally finished where they
   * are; a step still live at this point is reported as interrupted rather than
   * left spinning under whatever the command prints next.
   */
  stop: () => void;
}

export interface ProgressOptions {
  readonly stream?: ProgressStream;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clock?: ProgressClock;
}

/**
 * How long, in words.
 *
 * Under a minute reads as seconds because that is the resolution anyone watching
 * a start-up cares about; past it, `m 05s` because "312s" is not something a
 * person does arithmetic on while waiting.
 */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

/**
 * The one line an indicator is allowed to spend.
 *
 * A failure is usually a paragraph: a refusal carries its own remedy, and an
 * unexpected throw carries a suggestion. Both are printed in full by whoever
 * fails; the indicator's job is to name which step died, so it takes the first
 * line and leaves the rest where it belongs.
 */
export const failureReason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n', 1)[0] ?? text;
  const trimmed = firstLine.trim();
  return trimmed.length === 0 ? 'failed without a message' : trimmed;
};

/**
 * The last line a write left behind, as text.
 *
 * Only the end of it matters — the reporter is asking whether the writer finished
 * its line — so a buffer is decoded, and anything it cannot read counts as "no
 * newline", which is the safe answer: it leaves the cursor alone.
 */
const writtenText = (chunk: unknown): string => {
  if (typeof chunk === 'string') {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
};

interface ActiveStep {
  readonly label: string;
  /** This step and its ancestors *within the same service*, joined. */
  readonly chain: string;
  readonly startedAt: number;
  settled: boolean;
}

interface Scope {
  /** Empty for the run itself; a service name for a service. */
  readonly label: string;
  readonly steps: ActiveStep[];
  /** The service-level entry, which is what the scope's name refers to. */
  readonly service: ActiveStep | undefined;
}

export const createProgress = (options: ProgressOptions = {}): Progress => {
  const stream = options.stream ?? processStdout;
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? systemClock;

  const unicode = environment.TERM !== 'dumb';
  const frames = unicode ? UNICODE_FRAMES : ASCII_FRAMES;
  // Animation needs a terminal that repaints. Everything else gets the lines.
  const animated = stream.isTTY === true && environment.CI !== 'true' && unicode;
  const colour = animated && environment.NO_COLOR === undefined;

  const scopes: Scope[] = [];
  let stopTicking: (() => void) | undefined;
  let restoreStream: (() => void) | undefined;
  let frame = 0;
  /** Depth of our own writes. A foreign write is anything that reaches the stream outside one. */
  let owned = 0;

  const write = (text: string): void => {
    owned += 1;
    try {
      stream.write(text);
    } finally {
      owned -= 1;
    }
  };

  const paint = (code: string, text: string): string =>
    colour ? `\u001b[${code}m${text}\u001b[0m` : text;

  /**
   * Columns the label may use, measured in *visible* characters.
   *
   * The budget comes from the plain text, never from the painted string: nine
   * escape bytes do not occupy nine columns, and budgeting against them turned an
   * 80-column terminal into a 20-character one with the step name cut off. Zero is
   * what a pty with no window size reports, and it means "I do not know" rather
   * than "I am two dozen columns wide" — taking it literally produced a line that
   * showed one word and cut the step's name in half.
   */
  const room = (): number => {
    const columns = stream.columns === undefined || stream.columns <= 0 ? 80 : stream.columns;
    return Math.max(MIN_COLUMNS, columns - 1);
  };
  const fit = (text: string, available: number): string =>
    text.length <= available ? text : `${text.slice(0, Math.max(1, available - 1))}…`;

  const erase = (): void => {
    if (animated) {
      write('\r\u001b[2K');
    }
  };

  /** Every step still running, in any scope. */
  const live = (): ActiveStep[] => scopes.flatMap((scope) => scope.steps);

  /**
   * The one step to draw.
   *
   * The scope that most recently did something wins, so a service that is making
   * progress holds the line. When it finishes, the search walks back to whichever
   * scope still has something running — that hand-off is the difference between
   * "the indicator stopped" and "the indicator moved on".
   */
  const focused = (): { scope: Scope; step: ActiveStep } | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index] as Scope;
      const step = scope.steps[scope.steps.length - 1];
      if (step !== undefined) {
        return { scope, step };
      }
    }
    return undefined;
  };

  const chainOf = (scope: Scope, chain: string): string =>
    scope.label.length === 0 ? chain : `${scope.label} -> ${chain}`;

  const draw = (): void => {
    const current = focused();
    if (!animated || current === undefined) {
      return;
    }
    frame += 1;
    const elapsed = formatElapsed(clock.now() - current.step.startedAt);
    const available = room() - elapsed.length - 2;
    const chain = chainOf(current.scope, current.step.chain);
    // The full chain is more useful than the innermost label, so it is preferred —
    // but a cut-off chain hides which step is running, and that is the one thing
    // the line exists to say. Below the room needed for it, the innermost label
    // wins.
    const shown = chain.length <= available ? chain : fit(current.step.label, available);
    write(`\r\u001b[2K${frames[frame % frames.length]} ${shown} ${paint(DIM, elapsed)}`);
  };

  /**
   * Take the line back from anything else that prints.
   *
   * Installed for the duration of the first step and removed after the last, so
   * the patch is observable only while a run is genuinely in progress. Restoration
   * puts back the prototype method rather than a bound copy of it, because this
   * is `process.stdout` and everything else in the workspace writes to it.
   */
  const takeTheLine = (): void => {
    if (restoreStream !== undefined) {
      return;
    }
    const target = stream as { write: unknown };
    const original = target.write as (...args: unknown[]) => boolean;
    const forward = (args: unknown[]): boolean => Reflect.apply(original, stream, args) as boolean;

    const patched = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      // Our own writes, and writes with no live line to disturb.
      if (owned > 0 || live().length === 0) {
        return forward([chunk, encoding, callback]);
      }
      erase();
      const result = forward([chunk, encoding, callback]);
      // Redraw only behind a completed line. A writer mid-line still owns the rest
      // of it, and drawing here would put a spinner in the middle of their text.
      if (writtenText(chunk).endsWith('\n')) {
        draw();
      }
      return result;
    };

    target.write = patched;
    restoreStream = () => {
      target.write = original;
    };
  };

  const releaseTheLine = (): void => {
    stopTicking?.();
    stopTicking = undefined;
    restoreStream?.();
    restoreStream = undefined;
  };

  const announce = (): void => {
    // Only an animated run needs a clock. A pipe gets its lines when a step ends,
    // so a ticker there would be a timer waking up eleven times a second to do
    // nothing — in CI, which is where an idle event-loop handle is least welcome.
    if (animated && stopTicking === undefined) {
      takeTheLine();
      stopTicking = clock.every(FRAME_MS, draw);
    }
  };

  const finish = (entry: ActiveStep, ok: boolean, note: string | undefined): void => {
    if (entry.settled) {
      return;
    }
    entry.settled = true;

    // The scope that *owns* this entry, found before it is removed from that scope.
    //
    // Finding it afterwards cannot work: the entry has already been spliced out, so
    // the search finds nothing and the committed line loses its service name —
    // `checking the credentials`, with nothing to say which service was doing it.
    const owner = scopes.find((scope) => scope.service === entry || scope.steps.includes(entry));

    for (const scope of scopes) {
      const index = scope.steps.indexOf(entry);
      if (index >= 0) {
        scope.steps.splice(index, 1);
      }
    }
    const elapsed = formatElapsed(clock.now() - entry.startedAt);
    const suffix = note === undefined || note.length === 0 ? '' : ` — ${note}`;
    // Visible characters only: the two-space indent, the mark, the elapsed time and
    // the note are what the terminal has to fit.
    // Three shapes, and conflating any two of them reads as a bug: a service-level
    // entry is already the service's own name, so prefixing it again prints
    // `supabase -> supabase`; a step inside a service borrows its name as a prefix;
    // and a step on the run itself has an unlabelled owner, so its chain passes
    // through unchanged.
    const chain =
      owner === undefined || owner.service === entry ? entry.chain : chainOf(owner, entry.chain);
    const label = fit(chain, room() - elapsed.length - suffix.length - 4);
    erase();
    write(
      `  ${paint(ok ? GREEN : RED, ok ? '✓' : '✗')} ${label} ${paint(DIM, elapsed)}` +
        `${suffix.length === 0 ? '' : paint(DIM, suffix)}\n`,
    );
    if (live().length === 0) {
      releaseTheLine();
    } else {
      // Something else is still running, so whichever scope that is takes the
      // line back — a handover, not a stop.
      draw();
    }
  };

  const begin = (scope: Scope, label: string): ActiveStep => {
    // Nest only inside a service. Two services are *peers* starting at the same
    // time, and nesting the second under the first prints `supabase -> stripe` —
    // which reads as though Stripe's startup were a step of the database's, and
    // names neither correctly. A step on the run itself is always top-level.
    const parent = scope.label.length === 0 ? undefined : scope.steps[scope.steps.length - 1];
    const entry: ActiveStep = {
      label,
      chain: parent === undefined ? label : `${parent.chain} -> ${label}`,
      startedAt: clock.now(),
      settled: false,
    };
    scope.steps.push(entry);
    announce();
    erase();
    if (!animated) {
      write(`  ${paint(DIM, '->')} ${chainOf(scope, entry.chain)}\n`);
    }
    draw();
    return entry;
  };

  const handle = (entry: ActiveStep): ProgressStep => ({
    done: (outcome?: string) => {
      finish(entry, true, outcome);
    },
    fail: (reason: string) => {
      finish(entry, false, reason);
    },
  });

  const runScope: Scope = { label: '', steps: [], service: undefined };
  scopes.push(runScope);

  return {
    step: (label: string) => handle(begin(runScope, label)),

    service: (label: string): ServiceProgress => {
      // The service-level entry lives in the run's scope, so it is reported as a
      // peer of any other service rather than as a step of one.
      const service = begin(runScope, label);
      const scope: Scope = { label, steps: [], service };
      scopes.push(scope);
      return {
        step: (child: string) => handle(begin(scope, child)),
        done: (outcome?: string) => {
          finish(service, true, outcome);
        },
        fail: (reason: string) => {
          finish(service, false, reason);
        },
      };
    },

    stop: () => {
      for (const entry of [...live()]) {
        finish(entry, false, 'interrupted');
      }
      // A caller can stop twice, and a step begun after a stop must still work.
      releaseTheLine();
    },
  };
};

/**
 * Run `work` as a step.
 *
 * The shape every service needs: the work is announced before it runs, its elapsed
 * time is reported when it ends, a failure is named on the indicator *and*
 * rethrown, and a caller cannot forget the second half without also skipping the
 * first. `outcome` turns the result into the short note worth printing — "12 notes",
 * "reused; sources unchanged" — because a step that finished without saying what
 * it produced leaves the reader to guess whether it did anything.
 */
export const reportStep = async <T>(
  stepper: Stepper,
  label: string,
  work: () => Promise<T>,
  outcome?: (value: T) => string | undefined,
): Promise<T> => {
  const current = stepper.step(label);
  try {
    const value = await work();
    current.done(outcome?.(value));
    return value;
  } catch (error) {
    current.fail(failureReason(error));
    throw error;
  }
};
