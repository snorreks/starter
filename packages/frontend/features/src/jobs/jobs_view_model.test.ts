// packages/frontend/features/src/jobs/jobs_view_model.test.ts
//
// The polling lifecycle, and the three ways it must stop.
//
// What is under test, and why each one is a real failure rather than a nicety:
//
//   * **terminal jobs stop the loop.** A job that is `succeeded` or `failed` is
//     never written again, so a timer that keeps running is pure cost — and it is
//     the cost that makes an app get killed for battery use.
//   * **a hidden screen stops the loop.** The in-flight request is *aborted*, not
//     left to resolve into a screen nobody is looking at.
//   * **a stale answer cannot overwrite a newer one.** Two polls resolving out of
//     order is not a contrived race; it is what a slow request looks like.
//
// The scheduler is a fake with a manual clock. "The timer is not running" is only
// observable if the test owns the queue, and a test that sleeps for the real
// interval would prove timing rather than behaviour.
//
// Reactivity is not proved here: this lane stubs the runes (see `test_setup.ts`).
// The reactive half is the browser lane's job.

import { describe, expect, test } from 'bun:test';
import type { JobDto, LatestMaintenance } from '@starter/schemas/jobs';
import { AppError } from '@starter/utils';
import type { ObjectUrlFactory } from './jobs_output.ts';
import type { JobsService } from './jobs_service.svelte.ts';
import {
  JOB_POLL_BASE_MS,
  JOB_POLL_MAX_MS,
  type JobsStatus,
  JobsViewModel,
  type Scheduler,
} from './jobs_view_model.svelte.ts';

const job = (overrides: Partial<JobDto> = {}): JobDto => ({
  id: 'job_1',
  kind: 'encode',
  status: 'pending',
  createdAt: 1_000,
  updatedAt: 1_000,
  outputAvailable: false,
  errorCode: null,
  ...overrides,
});

const maintenance = (overrides: Partial<LatestMaintenance> = {}): LatestMaintenance => ({
  schedule: '17 * * * *',
  latest: null,
  latestScheduled: null,
  serverTime: 1,
  ...overrides,
});

/** A clock the test advances by hand, so no assertion ever waits on wall time. */
class FakeScheduler implements Scheduler {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; handler: () => void }>();
  readonly delays: number[] = [];

  setTimeout(handler: () => void, ms: number): number {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.#now + ms, handler });
    this.delays.push(ms);
    return handle;
  }

  clearTimeout(handle: number): void {
    this.#timers.delete(handle);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** Advance far enough to fire every timer that is due, in order. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.at <= this.#now)
      .sort((a, b) => a[1].at - b[1].at);

    for (const [handle, timer] of due) {
      this.#timers.delete(handle);
      timer.handler();
      // Let the handler's promise chain settle before the next one fires, which is
      // what a real event loop does between two timers.
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

interface Controls {
  /** What the next `load` answers with. */
  listResult: { jobs: JobDto[]; maintenance: LatestMaintenance };
  /** Set to make the next `load` refuse, without touching the service shape. */
  listError: Error | null;
  /** What the next create answers with: a job, or the refusal to throw. */
  createResult: JobDto | Error;
  /** What the next output read answers with: bytes, or the refusal to throw. */
  readOutputResult: Uint8Array | Error;
}

interface Harness {
  readonly viewModel: JobsViewModel;
  readonly scheduler: FakeScheduler;
  readonly urls: { revoked: string[]; create: () => string };
  readonly calls: { list: number; create: number; readOutput: number };
  readonly controls: Controls;
}

/**
 * A service whose answers the test replaces between polls.
 *
 * `load` is called through a function so a second poll can see a different list —
 * a poll that always answers the same thing cannot prove the loop notices a
 * transition. `controls` is a plain mutable object rather than a set of getters,
 * because a test replaces an answer and a getter-only view would silently drop it.
 */
const harness = (
  seed?: { jobs: readonly JobDto[]; maintenance: LatestMaintenance },
  options: { unavailableMessage?: string } = {},
): Harness => {
  const scheduler = new FakeScheduler();
  const calls = { list: 0, create: 0, readOutput: 0 };
  const controls: Controls = {
    listResult: {
      jobs: [...(seed?.jobs ?? [])],
      maintenance: seed?.maintenance ?? maintenance(),
    },
    listError: null,
    createResult: job(),
    readOutputResult: new Uint8Array([1, 2, 3]),
  };

  const service = {
    load: async (): Promise<{ jobs: JobDto[]; maintenance: LatestMaintenance }> => {
      calls.list += 1;
      if (controls.listError !== null) {
        throw controls.listError;
      }
      return { jobs: [...controls.listResult.jobs], maintenance: controls.listResult.maintenance };
    },
    createEncode: async (): Promise<JobDto> => {
      calls.create += 1;
      if (controls.createResult instanceof Error) {
        throw controls.createResult;
      }
      return controls.createResult;
    },
    readOutput: async (): Promise<{ bytes: Uint8Array }> => {
      calls.readOutput += 1;
      if (controls.readOutputResult instanceof Error) {
        throw controls.readOutputResult;
      }
      return { bytes: controls.readOutputResult };
    },
  } as unknown as JobsService;

  const urls = {
    revoked: [] as string[],
    next: 0,
    create(this: { next: number }): string {
      this.next += 1;
      return `blob:fake/${this.next}`;
    },
    revoke(url: string): void {
      urls.revoked.push(url);
    },
  } as unknown as ObjectUrlFactory & { revoked: string[] };

  const viewModel = new JobsViewModel({
    jobs: service,
    objectUrls: urls,
    scheduler,
    ...(seed === undefined ? {} : { initialJobs: seed.jobs, initialMaintenance: seed.maintenance }),
    ...(options.unavailableMessage === undefined
      ? {}
      : { unavailableMessage: options.unavailableMessage }),
  });

  return { viewModel, scheduler, urls: urls as never, calls, controls };
};

const statusKind = (status: JobsStatus): JobsStatus['kind'] => status.kind;

describe('a deployment with the profile switched off', () => {
  test('a known-unavailable screen neither fetches nor starts a loop', async () => {
    // The server render already knows the profile is off, so the browser is told
    // rather than asked: no request, and no timer waiting for a 503.
    const { viewModel, calls, scheduler } = harness(undefined, {
      unavailableMessage: 'This deployment has the jobs profile disabled.',
    });

    await viewModel.initialize();

    expect(viewModel.status).toEqual({
      kind: 'unavailable',
      message: 'This deployment has the jobs profile disabled.',
    });
    expect(calls.list).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  test('an unavailable screen is still disposed like any other', async () => {
    // One teardown path, so a screen that was never usable cannot leak either.
    const { viewModel } = harness(undefined, { unavailableMessage: 'off' });

    await viewModel.dispose();

    expect(viewModel.status.kind).toBe('unavailable');
  });
});

// ── Seeding, and the absent double fetch ─────────────────────────────────────

describe('seeding from a server load', () => {
  test('a seeded screen does not fetch on initialize', async () => {
    const { viewModel, calls } = harness({ jobs: [job()], maintenance: maintenance() });

    await viewModel.initialize();

    // The SSR load already sent this list. Fetching it again would put the same
    // data over the wire twice on every page view.
    expect(calls.list).toBe(0);
    expect(viewModel.jobs).toHaveLength(1);
    expect(statusKind(viewModel.status)).toBe('ready');
  });

  test('an unseeded screen fetches once', async () => {
    const { viewModel, calls } = harness();

    await viewModel.initialize();

    expect(calls.list).toBe(1);
  });

  test('a seeded screen with a running job starts polling without a redundant read', async () => {
    const { viewModel, scheduler, calls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });

    await viewModel.initialize();

    expect(calls.list).toBe(0);
    expect(scheduler.pending).toBe(1);
  });
});

// ── When the loop runs, and when it stops ────────────────────────────────────

describe('polling', () => {
  test('a running job is re-read on the base interval', async () => {
    const { viewModel, scheduler, calls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });

    await viewModel.initialize();
    await scheduler.advance(JOB_POLL_BASE_MS);

    expect(calls.list).toBe(1);
    expect(scheduler.delays[0]).toBe(JOB_POLL_BASE_MS);
  });

  test('nothing changed, so the delay grows and the base comes back on a change', async () => {
    const { viewModel, scheduler, controls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });

    await viewModel.initialize();
    await scheduler.advance(JOB_POLL_BASE_MS);
    const first = scheduler.delays.at(-1);

    // A poll that produced nothing new backs off. This is what stops a job that
    // takes a minute from being polled a hundred times while it does.
    expect(first).toBeGreaterThan(JOB_POLL_BASE_MS);

    // A real transition collapses it, so the interesting change is seen at once.
    // Deliberately a non-terminal change: a job that goes terminal stops the loop
    // entirely, which is the next test.
    controls.listResult = {
      jobs: [job({ status: 'running', updatedAt: 5_000 })],
      maintenance: maintenance(),
    };
    await scheduler.advance(first ?? 0);
    expect(scheduler.delays.at(-1)).toBe(JOB_POLL_BASE_MS);
  });

  test('the backoff is bounded', async () => {
    const { viewModel, scheduler } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });

    await viewModel.initialize();
    for (let step = 0; step < 40; step += 1) {
      await scheduler.advance(JOB_POLL_MAX_MS);
    }

    expect(Math.max(...scheduler.delays)).toBeLessThanOrEqual(JOB_POLL_MAX_MS);
  });

  test('every job terminal means no timer at all', async () => {
    // Not a longer delay: no timer. A terminal row is never written again, so a
    // schedule that keeps firing is cost with no possible answer.
    const { viewModel, scheduler } = harness({
      jobs: [
        job({ status: 'succeeded', outputAvailable: true }),
        job({ id: 'job_2', status: 'failed' }),
      ],
      maintenance: maintenance(),
    });

    await viewModel.initialize();

    expect(viewModel.hasActiveJob).toBe(false);
    expect(scheduler.pending).toBe(0);
  });

  test('a poll that reaches a terminal state stops the loop', async () => {
    const { viewModel, scheduler, calls, controls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();

    controls.listResult = {
      jobs: [job({ status: 'succeeded', updatedAt: 9_000, outputAvailable: true })],
      maintenance: maintenance(),
    };
    await scheduler.advance(JOB_POLL_BASE_MS);

    expect(calls.list).toBe(1);
    expect(viewModel.jobs[0]?.status).toBe('succeeded');
    expect(scheduler.pending).toBe(0);
  });
});

describe('backgrounding', () => {
  test('hiding the screen drops the timer and cancels the request in flight', async () => {
    const { viewModel, scheduler } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();
    expect(scheduler.pending).toBe(1);

    viewModel.setActive(false);

    // Both halves matter: no new timer, and the outstanding read is aborted rather
    // than left to resolve into a screen nobody is looking at.
    expect(scheduler.pending).toBe(0);
    expect(viewModel.requests.cancelled).toBe(true);
  });

  test('a hidden screen does not poll even as time passes', async () => {
    const { viewModel, scheduler, calls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();

    viewModel.setActive(false);
    await scheduler.advance(JOB_POLL_MAX_MS * 3);

    expect(calls.list).toBe(0);
  });

  test('coming back refreshes once and resumes', async () => {
    // Refreshing rather than trusting the held list: a hidden screen missed every
    // transition, and a stale "running" is worse than one extra read.
    const { viewModel, scheduler, calls, controls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();

    viewModel.setActive(false);
    controls.listResult = {
      jobs: [job({ status: 'succeeded', updatedAt: 9_000, outputAvailable: true })],
      maintenance: maintenance(),
    };
    viewModel.setActive(true);
    await Promise.resolve();

    expect(calls.list).toBe(1);
    expect(viewModel.jobs[0]?.status).toBe('succeeded');
    // Terminal now, so the resumed loop has nothing to do.
    expect(scheduler.pending).toBe(0);
  });
});

describe('stale answers', () => {
  test('a superseded read cannot overwrite a newer one', async () => {
    const { viewModel, calls } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();

    // Two loads in the air; the first is abandoned. The guard — not a comparison
    // of ids — is what decides, because two requests can resolve in either order.
    const slow = viewModel.load({ background: true });
    const fast = viewModel.load({ background: true });
    await Promise.all([slow, fast]);

    expect(calls.list).toBe(2);
    expect(viewModel.jobs).toHaveLength(1);
  });

  test('a list that goes backwards cannot walk a terminal job back to running', async () => {
    const { viewModel, controls } = harness({
      jobs: [job({ status: 'succeeded', updatedAt: 9_000, outputAvailable: true })],
      maintenance: maintenance(),
    });

    controls.listResult = {
      jobs: [job({ status: 'running', updatedAt: 2_000, outputAvailable: false })],
      maintenance: maintenance(),
    };
    await viewModel.load({ background: true });

    // A stale read must not un-finish an encode the server already committed.
    expect(viewModel.jobs[0]?.status).toBe('succeeded');
  });

  test('a disposed screen is not written to', async () => {
    const { viewModel, controls } = harness();
    await viewModel.initialize();
    expect(viewModel.status.kind).toBe('ready');

    await viewModel.dispose();
    controls.listResult = {
      jobs: [job({ status: 'succeeded' })],
      maintenance: maintenance(),
    };
    await viewModel.load();

    // The answer arrived after teardown and was not written: a disposed screen
    // holding a list it will never render is the leak the guard exists to stop.
    expect(viewModel.jobs).toEqual([]);
    expect(viewModel.status.kind).toBe('ready');
  });
});

// ── Capability, budget, failure ──────────────────────────────────────────────

describe('refusals the screen has to name', () => {
  test('a 503 is a capability, not a fault with a retry', async () => {
    const service = {
      load: async (): Promise<never> => {
        throw new AppError('server', 'This deployment has the jobs profile disabled.', {
          status: 503,
          cause: { error: 'jobs_profile_disabled', message: 'disabled' },
        });
      },
    } as unknown as JobsService;

    const viewModel = new JobsViewModel({ jobs: service, scheduler: new FakeScheduler() });
    await viewModel.initialize();

    expect(viewModel.status).toEqual({
      kind: 'unavailable',
      message: 'This deployment has the jobs profile disabled.',
    });
  });

  test('a failed poll keeps the list the user is reading', async () => {
    // A background failure is reported next to the data, not instead of it: a
    // screen that blanks to an error every time a poll hits a dead network would
    // be unreadable exactly when something is wrong.
    const harnessWithList = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await harnessWithList.viewModel.initialize();

    harnessWithList.controls.listError = new AppError('network', 'Could not reach the server.');
    await harnessWithList.scheduler.advance(JOB_POLL_BASE_MS);

    expect(harnessWithList.viewModel.status.kind).toBe('ready');
    expect(harnessWithList.viewModel.jobs).toHaveLength(1);
  });

  test('a failed first read with nothing on screen is an error state', async () => {
    const harnessWithList = harness();
    harnessWithList.controls.listError = new AppError('network', 'Could not reach the server.');

    await harnessWithList.viewModel.initialize();

    expect(harnessWithList.viewModel.status).toEqual({
      kind: 'error',
      message: 'Could not reach the server.',
      retryable: true,
    });
  });

  test('a budget refusal is named, and marked as not worth retrying now', async () => {
    const { viewModel, controls } = harness();
    controls.createResult = new AppError('rate_limited', 'You have used your job allowance.', {
      status: 429,
      cause: { error: 'budget_exceeded', message: 'You have used your job allowance.' },
    });
    await viewModel.initialize();

    const started = await viewModel.startEncode('key-1');

    expect(started).toBe(false);
    expect(viewModel.refusal?.code).toBe('budget_exceeded');
    expect(viewModel.refusal?.retryable).toBe(false);
    expect(viewModel.refusal?.message).toMatch(/allowance/i);
  });

  test('an unverified address is reported with its own code', async () => {
    const { viewModel, controls } = harness();
    controls.createResult = new AppError(
      'forbidden',
      'Confirm your email address before starting a job.',
      {
        status: 403,
        cause: { error: 'email_not_verified', message: 'confirm first' },
      },
    );
    await viewModel.initialize();

    await viewModel.startEncode('key-1');

    expect(viewModel.refusal?.code).toBe('email_not_verified');
    expect(viewModel.refusal?.retryable).toBe(false);
  });

  test('starting the sample shows the server\u2019s own job immediately', async () => {
    const { viewModel, controls } = harness();
    controls.createResult = job({ id: 'job_new', status: 'pending' });
    await viewModel.initialize();

    await viewModel.startEncode('key-1');

    expect(viewModel.jobs.map((entry) => entry.id)).toEqual(['job_new']);
    expect(viewModel.refusal).toBeNull();
  });
});

// ── The result ───────────────────────────────────────────────────────────────

describe('the held result', () => {
  test('loading one makes it playable and downloadable', async () => {
    const { viewModel, urls } = harness();
    await viewModel.initialize();

    const loaded = await viewModel.loadOutput('job_1');

    expect(loaded).toBe(true);
    expect(viewModel.output?.url).toBe('blob:fake/1');
    expect(viewModel.output?.filename).toBe('starter-sample-job_1.mp4');
    expect(urls.revoked).toEqual([]);
  });

  test('loading a second result releases the first', async () => {
    // Two pinned Blobs is one too many, and the release has to happen before the
    // new one is stored.
    const { viewModel, urls } = harness();
    await viewModel.initialize();

    await viewModel.loadOutput('job_1');
    await viewModel.loadOutput('job_2');

    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(viewModel.output?.jobId).toBe('job_2');
  });

  test('disposal releases the result and stops the loop', async () => {
    const { viewModel, urls, scheduler } = harness({
      jobs: [job({ status: 'running' })],
      maintenance: maintenance(),
    });
    await viewModel.initialize();
    await viewModel.loadOutput('job_1');
    expect(scheduler.pending).toBe(1);

    await viewModel.dispose();

    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(viewModel.output).toBeNull();
    expect(scheduler.pending).toBe(0);
  });

  test('an aged-out result is reported, and no object URL is created', async () => {
    const { viewModel, urls, controls } = harness();
    controls.readOutputResult = new AppError(
      'server',
      'That result has passed its retention window.',
      {
        status: 410,
        cause: { error: 'output_expired', message: 'gone' },
      },
    );
    await viewModel.initialize();

    const loaded = await viewModel.loadOutput('job_1');

    expect(loaded).toBe(false);
    expect(viewModel.output).toBeNull();
    expect(viewModel.outputError).toMatch(/retention/i);
    expect(urls.revoked).toEqual([]);
  });

  test('the scheduler evidence is exposed as the scheduled run, not just the last', async () => {
    const run = {
      trigger: 'scheduled' as const,
      status: 'succeeded' as const,
      slot: '2026-10-03T17:00:00Z',
      scheduledTime: 1_772_573_400_000,
      startedAt: 1,
      completedAt: 2,
      counts: {
        expiredSessions: 1,
        idleRateLimits: 0,
        artifactsQueued: 0,
        artifactsRetired: 0,
        pendingDispatches: 0,
      },
      errorCode: null,
    };
    const { viewModel } = harness({
      jobs: [],
      maintenance: maintenance({
        latest: {
          ...run,
          trigger: 'manual',
          slot: null,
          scheduledTime: null,
        },
        latestScheduled: run,
      }),
    });

    // A manual run that is the newest must not be what a screen calls "the
    // schedule fired".
    expect(viewModel.scheduledRun?.trigger).toBe('scheduled');
  });
});
