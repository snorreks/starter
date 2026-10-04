// packages/frontend/features/src/jobs/jobs_view_model.svelte.ts
//
// The jobs screen's state and commands, shared by the web app and the native shell.
//
// Four properties this class is responsible for, and each is a specific failure it
// prevents:
//
//   1. **It stops polling.** A job that is `pending` or `running` is worth
//      re-reading; a job that is `succeeded` or `failed` will never change again,
//      because a job row is only written by an attempt and an attempt only runs
//      while the job is active. A screen that keeps polling after every job is
//      terminal is a battery drain and a log of requests nobody needed, and the
//      way to be sure it has stopped is to not hold a timer at all.
//
//   2. **It backs off.** Polling a Workflow that takes a minute at a fixed 500 ms
//      is forty times more requests than the answer needs. The delay grows while
//      nothing changes and collapses to the base the moment a job's `updatedAt`
//      moves, so a real transition is seen quickly and a stuck job costs little.
//
//   3. **It stops when nobody is looking.** `setActive(false)` — a hidden tab, a
//      suspended native window — cancels the in-flight request *and* drops the
//      timer. Resuming refreshes once and starts the loop again. A native shell
//      that keeps polling in the background is the failure mode that gets an app
//      killed by the OS for battery use.
//
//   4. **It cannot be written to after teardown.** `StaleGuard` for reads,
//      `MutationGuard` for writes, and one cleared timer, disposed in a fixed
//      order. The stale guard is what makes "an older list must not overwrite a
//      newer one" a property rather than a hope: two polls can resolve in either
//      order and only the newest token may write.
//
// Nothing here is a module singleton. The whole class is constructed per screen
// from an injected `JobsService`, which is what lets the browser lane mount this
// with a fake and the two hosts share it.

import type {
  JobAdmissionErrorCodeValue,
  JobDto,
  JobStatus,
  LatestMaintenance,
  MaintenanceEvidence,
} from '@starter/schemas/jobs';
import { reportError } from '@starter/ui';
import {
  disposeScreen,
  runScreenWrite,
  type ScreenGuards,
  type ScreenOwner,
} from '@starter/ui/screen';
import { MutationGuard, StaleGuard, toAppError } from '@starter/utils';
import {
  type JobOutputHandle,
  JobOutputRejectedError,
  type ObjectUrlFactory,
  takeOutputHandle,
} from './jobs_output.ts';
import type { JobsService } from './jobs_service.svelte.ts';

/**
 * Polling bounds, in milliseconds.
 *
 * `BASE` is the first wait after a real change and the shortest gap between two
 * reads. `MAX` is the ceiling the backoff climbs to, which is what makes a job
 * that never finishes cost a bounded number of requests rather than an unbounded
 * number spread over its whole run.
 */
export const JOB_POLL_BASE_MS = 1_500;
export const JOB_POLL_MAX_MS = 20_000;

/** Multiplier applied once per interval that produced no change. */
export const JOB_POLL_BACKOFF = 1.5;

/** States with no further writes, so nothing is gained by reading them again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed'];

/**
 * Refusals a second identical request cannot fix.
 *
 * The screen's own set rather than a status-code switch, because three of these
 * are 4xx for different reasons: 403 for an unconfirmed address, 409 for a key
 * reused with a different body, 429 for an exhausted allowance. Treating all of
 * them as "retry" is what produces a button that fails identically every time.
 */
const TERMINAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'budget_exceeded',
  'email_not_verified',
  'idempotency_conflict',
  'invalid_request',
  'invalid_idempotency_key',
  'jobs_profile_disabled',
]);

/**
 * The screen's status, as a union rather than three booleans.
 *
 * `unavailable` is separate from `error` on purpose: it is the deployment saying
 * the compute profile is off, which is not a failure of this screen and must not
 * be rendered with a retry button that cannot help.
 */
export type JobsStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string; retryable: boolean };

/** Why a create attempt was refused, in the API's own words. */
export interface JobStartRefusal {
  readonly code: JobAdmissionErrorCodeValue | 'unknown';
  readonly message: string;
  /** True when waiting will help, which for a budget is not the case. */
  readonly retryable: boolean;
}

export interface JobsScreenOptions {
  readonly jobs: JobsService;
  /** The list the SSR load already produced, so the first paint is not empty. */
  readonly initialJobs?: readonly JobDto[];
  /**
   * The scheduler evidence the SSR load already produced.
   *
   * Nullable because a deployment with the profile switched off, or one that has
   * never swept, has none — and "no evidence yet" must render as such rather than
   * as a missing read.
   */
  readonly initialMaintenance?: LatestMaintenance | null;
  /**
   * The server already knows this deployment has jobs switched off.
   *
   * Passed rather than discovered, so a disabled profile costs the browser no
   * request at all: the page renders its "switched off here" state from the HTML
   * and the ViewModel never asks. Without it the client would fetch, receive a
   * 503 and reach the same state one round trip later.
   */
  readonly unavailableMessage?: string;
  /**
   * Injected so a test can count revocations.
   *
   * Defaults to the browser's `URL.createObjectURL`. A ViewModel that reached for
   * the global directly could not be tested for the leak it exists to prevent.
   */
  readonly objectUrls?: ObjectUrlFactory;
  /**
   * Injected so a test controls the delays.
   *
   * `setTimeout` is the seam rather than a polling library because the thing worth
   * proving is that *the timer is not running*, and that is only observable with
   * the platform's own scheduling.
   */
  readonly scheduler?: Scheduler;
}

export interface Scheduler {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const platformScheduler: Scheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

export class JobsViewModel implements ScreenOwner, ScreenGuards {
  readonly className = 'JobsViewModel';

  /** Exposed so `ScreenContainer` and the free lifecycle functions can reach them. */
  readonly requests = new StaleGuard();
  readonly mutations = new MutationGuard();

  status = $state<JobsStatus>({ kind: 'loading' });
  /** Always replaced wholesale, never mutated in place. See `#merge`. */
  jobs = $state<JobDto[]>([]);
  maintenance = $state<LatestMaintenance | null>(null);
  /** The most recent refusal from the create button, or null. */
  refusal = $state<JobStartRefusal | null>(null);
  /** The playable result currently held, or null. See `jobs_output.ts`. */
  output = $state<JobOutputHandle | null>(null);
  /** True while a create is in the air. */
  starting = $state(false);
  /** False once the host reports the screen is no longer visible. */
  active = true;
  /** True while a read is in the air, so the view can say so without inventing progress. */
  refreshing = $state(false);
  /** Set when a result could not be fetched, or could not be played. */
  outputError = $state<string | null>(null);

  /** Claimed by `ScreenContainer`; never written from here. */
  mounted = false;

  readonly #jobs: JobsService;
  readonly #objectUrls: ObjectUrlFactory | undefined;
  readonly #scheduler: Scheduler;
  /** Byte fetches get their own guard: a poll must not abort a video. */
  readonly #artifacts = new StaleGuard();

  #timer: number | null = null;
  #delay = JOB_POLL_BASE_MS;
  /** True once the server's list — or the SSR one — has been taken. */
  #seeded = false;
  #disposed = false;

  constructor(options: JobsScreenOptions) {
    this.#jobs = options.jobs;
    this.#objectUrls = options.objectUrls;
    this.#scheduler = options.scheduler ?? platformScheduler;
    if (options.initialJobs !== undefined) {
      this.seed(options.initialJobs, options.initialMaintenance ?? null);
    }
    if (options.unavailableMessage !== undefined) {
      // Seeded *and* unavailable: `initialize()` must not read, and the loop must
      // not start, because there is nothing this deployment can answer.
      this.status = { kind: 'unavailable', message: options.unavailableMessage };
      this.#seeded = true;
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  get isEmpty(): boolean {
    return this.status.kind === 'ready' && this.jobs.length === 0;
  }

  /** True while at least one job can still change, which is the poll condition. */
  get hasActiveJob(): boolean {
    return this.jobs.some((job) => !TERMINAL_JOB_STATUSES.includes(job.status));
  }

  /** The newest scheduled run, which is the only one that is scheduler evidence. */
  get scheduledRun(): MaintenanceEvidence | null {
    return this.maintenance?.latestScheduled ?? null;
  }

  get activeJob(): JobDto | null {
    return this.jobs.find((job) => !TERMINAL_JOB_STATUSES.includes(job.status)) ?? null;
  }

  // ── Seeding ────────────────────────────────────────────────────────────────

  /**
   * Take a list the server already produced.
   *
   * Marks the screen seeded, so `initialize()` knows not to fetch what the SSR
   * load already sent. Without it the first paint arrives with the HTML and the
   * browser immediately asks for the same list again — the same data over the wire
   * twice on every page view, plus a flash while the duplicate resolves.
   */
  seed(jobs: readonly JobDto[], maintenance: LatestMaintenance | null): void {
    this.jobs = sortByRecency(jobs);
    this.maintenance = maintenance;
    this.status = { kind: 'ready' };
    this.#seeded = true;
  }

  async initialize(): Promise<void> {
    if (!this.#seeded) {
      await this.load();
      return;
    }
    // Seeded, but a job may already be running — so the loop starts without a
    // redundant first fetch.
    this.#schedule();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * One read of the list and the scheduler evidence.
   *
   * `background` marks a poll rather than a user action: it must not blank the
   * screen, because the alternative is a list that flickers to "loading" every
   * second and a user who cannot read it.
   */
  async load(options: { background?: boolean } = {}): Promise<void> {
    // `#disposed`, not `requests.cancelled`: the guard's latch is also what a
    // backgrounded screen sets, and `load` is precisely how such a screen comes
    // back. Only teardown refuses permanently.
    if (this.#disposed) {
      return;
    }

    const background = options.background === true;
    const { token, signal } = this.requests.begin();
    if (!background && !this.#seeded) {
      this.status = { kind: 'loading' };
    }
    this.refreshing = !background;

    try {
      const { jobs, maintenance } = await this.#jobs.load(signal);
      // After awaiting. A superseded or torn-down screen must not be written to,
      // and an older list must never overwrite a newer one.
      if (!this.requests.isCurrent(token)) {
        return;
      }

      const changed = this.#merge(jobs);
      this.maintenance = maintenance;
      this.status = { kind: 'ready' };
      this.#delay = changed ? JOB_POLL_BASE_MS : nextDelay(this.#delay);
      this.#schedule();
    } catch (error) {
      if (!this.requests.isCurrent(token)) {
        return;
      }
      const appError = toAppError(error, 'Could not load your jobs.');
      if (appError.errorType === 'aborted') {
        return;
      }

      if (appError.status === 503) {
        // The deployment has the compute profile off. That is a capability, not a
        // fault: the screen says so and does not offer a retry that cannot work.
        this.status = { kind: 'unavailable', message: appError.message };
        this.#clearTimer();
        return;
      }

      // A failed *poll* must not destroy a list the user is reading. The screen
      // keeps what it has and reports the failure next to it.
      this.status =
        this.#seeded && background
          ? { kind: 'ready' }
          : {
              kind: 'error',
              message: appError.message,
              retryable:
                appError.errorType !== 'forbidden' && appError.errorType !== 'unauthorized',
            };
      reportError(appError);
    } finally {
      if (this.requests.isCurrent(token)) {
        this.refreshing = false;
      }
    }
  }

  /**
   * Fold a fresh list into what is on screen.
   *
   * The merge is per job rather than a wholesale replace, and the rule is the
   * row's own `updatedAt`: a job that moved forward is taken, and a job that came
   * back stale — a slower request, a second tab — is dropped. Terminal states are
   * additionally treated as final, so a `succeeded` job cannot be walked back to
   * `running` by a list that was read before it committed.
   */
  #merge(fresh: readonly JobDto[]): boolean {
    const previous = new Map(this.jobs.map((job) => [job.id, job]));
    const merged: JobDto[] = [];
    let changed = false;

    for (const job of sortByRecency(fresh)) {
      const seen = previous.get(job.id);
      if (seen !== undefined) {
        if (TERMINAL_JOB_STATUSES.includes(seen.status)) {
          // Keep the terminal row, but take any newer availability answer.
          const settled: JobDto = { ...seen, outputAvailable: job.outputAvailable };
          merged.push(settled);
          changed = changed || settled.outputAvailable !== seen.outputAvailable;
          continue;
        }
        changed = changed || seen.status !== job.status || seen.updatedAt !== job.updatedAt;
        merged.push(job);
        continue;
      }
      merged.push(job);
      changed = true;
    }

    // A job that vanished from the server is gone, not hidden.
    changed = changed || merged.length !== this.jobs.length;
    this.jobs = merged;
    return changed;
  }

  // ── The poll loop ──────────────────────────────────────────────────────────

  /**
   * Whether another read is justified.
   *
   * Every clause is a place a screen could otherwise keep working for nobody: no
   * job can change, the window is not visible, the screen is torn down, the
   * deployment has no jobs to report, or a read is already in the air.
   */
  get #shouldPoll(): boolean {
    return this.active && !this.#disposed && this.status.kind === 'ready' && this.hasActiveJob;
  }

  #schedule(): void {
    this.#clearTimer();
    if (!this.#shouldPoll) {
      return;
    }
    const delay = this.#delay;
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = null;
      if (!this.#shouldPoll) {
        return;
      }
      void this.load({ background: true });
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Report whether this screen is worth working for.
   *
   * Hiding it cancels the request in flight and drops the timer; showing it
   * refreshes once and resumes. Refreshing on resume rather than trusting the
   * held list is the whole point: a suspended window missed every transition
   * while it was away, and a stale "running" is worse than one extra read.
   *
   * `StaleGuard.cancelAll()` is a latch, not a poison pill: the next `begin()`
   * re-opens it, which is what lets the same screen come back rather than being
   * reconstructed.
   */
  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;

    if (!active) {
      this.#clearTimer();
      this.requests.cancelAll();
      return;
    }

    this.#delay = JOB_POLL_BASE_MS;
    void this.load({ background: true });
  }

  /**
   * Refresh once and resume, for a host whose resume is an event rather than a
   * visibility flag.
   */
  resume(): void {
    this.active = true;
    this.#delay = JOB_POLL_BASE_MS;
    void this.load({ background: true });
  }

  // ── Starting a job ─────────────────────────────────────────────────────────

  /**
   * Start the one job this screen can start.
   *
   * The idempotency key is minted per attempt and reused for retries of *that*
   * attempt, so a dropped connection costs a repeat of the same request rather
   * than a second job. The server spends budget once per key, which is a property
   * it enforces atomically rather than one this screen has to be careful about.
   */
  async startEncode(idempotencyKey: string): Promise<boolean> {
    this.refusal = null;

    try {
      const started = await runScreenWrite(this, async (handle) => {
        this.starting = true;
        try {
          const job = await this.#jobs.createEncode(idempotencyKey, handle.signal);
          // The admitted job is the server's answer, so the list shows it without
          // waiting for the first poll. It arrives as `pending` — which is what
          // the server committed — and the poll replaces it with what the
          // Workflow actually did.
          this.jobs = sortByRecency([job, ...this.jobs.filter((entry) => entry.id !== job.id)]);
          this.status = { kind: 'ready' };
          return true;
        } finally {
          this.starting = false;
        }
      });

      if (started) {
        this.#delay = JOB_POLL_BASE_MS;
        this.#schedule();
        return true;
      }
      return false;
    } catch (error) {
      this.refuse(error);
      return false;
    }
  }

  /**
   * Explain a create refusal in the API's own terms.
   *
   * The code travels in the error envelope's `error` field and is read from there
   * rather than inferred from the status, because "you have used your hourly
   * allowance" and "this deployment cannot run jobs" are different sentences with
   * different remedies, and a status-code switch would render both as "something
   * went wrong".
   *
   * `retryable` means "the same request, sent again right now, would succeed".
   * Three codes cannot be: the allowance is spent, the address is unconfirmed, and
   * the key was used for a different body. A "Try again" button on any of those is
   * a control that cannot do anything.
   */
  refuse(error: unknown): JobStartRefusal {
    const appError = toAppError(error, 'Could not start the job.');
    const code = readErrorCode(appError.cause);
    const refusal: JobStartRefusal = {
      code,
      message:
        code === 'budget_exceeded'
          ? 'You have used this deployment\u2019s job allowance for now. Try again later.'
          : appError.message,
      retryable: !TERMINAL_REFUSAL_CODES.has(code) && appError.errorType !== 'validation',
    };
    this.refusal = refusal;
    reportError(appError);
    return refusal;
  }

  // ── The result ─────────────────────────────────────────────────────────────

  /**
   * Fetch one job's bytes and make them playable.
   *
   * The fetch goes through the transport — so the credential travels in a header
   * and never in a URL — and the answer becomes an owned Blob that this class is
   * responsible for releasing. Fetching a second result releases the first: two
   * pinned videos is one too many.
   */
  async loadOutput(jobId: string): Promise<boolean> {
    const { token, signal } = this.#artifacts.begin();
    this.outputError = null;

    try {
      const artifact = await this.#jobs.readOutput(jobId, { signal });
      if (!this.#artifacts.isCurrent(token)) {
        return false;
      }

      const handle = takeOutputHandle(jobId, artifact.bytes, this.#objectUrls);
      if (this.#artifacts.cancelled) {
        // Disposed between the read resolving and here. The handle is released
        // immediately rather than stored, because storing it would pin a Blob for
        // a screen nobody is looking at.
        handle.revoke();
        return false;
      }

      this.releaseOutput();
      this.output = handle;
      return true;
    } catch (error) {
      if (this.#artifacts.isCurrent(token)) {
        // An aged-out artifact and somebody else's job are different facts, and
        // the server already said which. Nothing about this screen can widen
        // them: the id it sent was a job the list handed it.
        this.outputError =
          error instanceof JobOutputRejectedError
            ? error.message
            : toAppError(error, 'Could not load that result.').message;
      }
      reportError(error, 'Could not load that result.');
      return false;
    }
  }

  /** Release the held result. Idempotent, and called on replacement. */
  releaseOutput(): void {
    this.output?.revoke();
    this.output = null;
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearTimer();
    this.#artifacts.cancelAll();
    // A released Blob is a video the user encoded, freed. In this order: the timer
    // first, so nothing new is scheduled; then the in-flight byte fetch, so it
    // cannot resolve into a revoked handle; then the handle itself.
    this.releaseOutput();
    disposeScreen(this);
  }
}

/** The next delay in the backoff, bounded. */
const nextDelay = (current: number): number =>
  Math.min(Math.round(current * JOB_POLL_BACKOFF), JOB_POLL_MAX_MS);

/** Newest first, so the job a user just started is the one at the top. */
const sortByRecency = (jobs: readonly JobDto[]): JobDto[] =>
  [...jobs].sort((a, b) => b.createdAt - a.createdAt);

/**
 * The refusal code from an error envelope.
 *
 * Read from `cause`, which the transport fills with the parsed `{ error, message }`
 * body. A closed union rather than `string`, so an unknown code reads as unknown
 * instead of being rendered verbatim.
 */
const readErrorCode = (cause: unknown): JobAdmissionErrorCodeValue | 'unknown' => {
  const code =
    typeof cause === 'object' && cause !== null && 'error' in cause
      ? (cause as { error?: unknown }).error
      : undefined;

  switch (code) {
    case 'invalid_request':
    case 'invalid_idempotency_key':
    case 'unauthenticated':
    case 'email_not_verified':
    case 'idempotency_conflict':
    case 'budget_exceeded':
    case 'jobs_profile_disabled':
      return code;
    default:
      return 'unknown';
  }
};
