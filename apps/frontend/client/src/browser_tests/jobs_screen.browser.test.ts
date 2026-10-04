// apps/frontend/client/src/browser_tests/jobs_screen.browser.test.ts
//
// The jobs screen through the real Svelte compiler in a real browser.
//
// This lane answers the questions the Bun lane cannot, because that lane stubs the
// runes (`@starter/features/src/test_setup.ts`) and therefore proves nothing about
// reactivity:
//
//   * does a job's new state actually reach the DOM, or only the ViewModel?
//   * does the player appear with a Blob URL the browser will actually load?
//   * does unmounting release that Blob, rather than pinning it for the session?
//   * does an unmount abort a read in flight instead of resolving into a component
//     that no longer exists?
//
// Nothing here talks to a network. The service is a fake, which is the point of
// the composition seam: the same View and ViewModel render in the web application
// and in a native window, and this lane needs neither.
import {
  type JobsService,
  JobsView,
  JobsViewModel,
  type ObjectUrlFactory,
} from '@starter/features/jobs';
import type { JobDto, LatestMaintenance } from '@starter/schemas/jobs';
import { AppError } from '@starter/utils';
import { flushSync } from 'svelte';
import { describe, expect, test } from 'vitest';
import { mountInDocument } from './mount_helper.ts';

const job = (overrides: Partial<JobDto> = {}): JobDto => ({
  id: 'job_1',
  kind: 'encode',
  status: 'pending',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  outputAvailable: false,
  errorCode: null,
  ...overrides,
});

const maintenance = (): LatestMaintenance => ({
  schedule: '17 * * * *',
  latest: null,
  latestScheduled: null,
  serverTime: 1,
});

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Object URLs counted, so a leak is an assertion rather than a suspicion. */
const countingUrls = (): ObjectUrlFactory & { revoked: string[] } => {
  const revoked: string[] = [];
  let next = 0;
  return {
    revoked,
    create: () => {
      next += 1;
      return `blob:jobs/${next}`;
    },
    revoke: (url) => {
      revoked.push(url);
    },
  };
};

interface Harness {
  viewModel: JobsViewModel;
  urls: ObjectUrlFactory & { revoked: string[] };
  /** What the next `load` answers with. */
  answer: { jobs: JobDto[]; maintenance: LatestMaintenance };
  /** Replaces `load` with one that never resolves, to observe cancellation. */
  stall: (deferred: Deferred<{ jobs: JobDto[]; maintenance: LatestMaintenance }>) => void;
  lastSignal: AbortSignal | null;
}

const harness = (seed: JobDto[] = []): Harness => {
  const state = {
    jobs: [...seed],
    maintenance: maintenance(),
    pending: null as Deferred<{ jobs: JobDto[]; maintenance: LatestMaintenance }> | null,
    signals: [] as AbortSignal[],
  };

  const service = {
    load: async (signal?: AbortSignal) => {
      if (signal !== undefined) {
        state.signals.push(signal);
      }
      if (state.pending !== null) {
        return state.pending.promise;
      }
      return { jobs: [...state.jobs], maintenance: state.maintenance };
    },
    createEncode: async () => job({ id: 'job_new' }),
    readOutput: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
  } as unknown as JobsService;

  const urls = countingUrls();
  const viewModel = new JobsViewModel({
    jobs: service,
    objectUrls: urls,
    initialJobs: seed,
    initialMaintenance: state.maintenance,
  });

  return {
    viewModel,
    urls,
    answer: {
      get jobs() {
        return state.jobs;
      },
      set jobs(value: JobDto[]) {
        state.jobs = value;
      },
      get maintenance() {
        return state.maintenance;
      },
      set maintenance(value: LatestMaintenance) {
        state.maintenance = value;
      },
    },
    stall: (deferred) => {
      state.pending = deferred;
    },
    get lastSignal() {
      return state.signals.at(-1) ?? null;
    },
  };
};

/** Let pending effects and promise callbacks settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const mountJobs = (viewModel: JobsViewModel) =>
  mountInDocument(JobsView as never, { viewModel, newIdempotencyKey: () => 'key-1' } as never);

describe('the jobs screen', () => {
  test('the seeded list is rendered by the server-supplied state', async () => {
    const { viewModel } = harness([job({ status: 'running' })]);

    const mounted = mountJobs(viewModel);
    await tick();
    flushSync();

    expect(mounted.target.querySelector('[data-testid="jobs-list"]')).not.toBeNull();
    expect(mounted.target.querySelector('[data-testid="job-status"]')?.textContent).toContain(
      'Encoding',
    );

    mounted.destroy();
  });

  test('a poll answer reaches the DOM', async () => {
    // The whole point of this lane: a `$state` write that does not reach the
    // element passes a ViewModel test and fails here.
    const harnessUnderTest = harness([job({ status: 'running' })]);
    const mounted = mountJobs(harnessUnderTest.viewModel);
    await tick();
    flushSync();

    harnessUnderTest.answer.jobs = [
      job({ status: 'succeeded', updatedAt: 1_700_000_060_000, outputAvailable: true }),
    ];
    await harnessUnderTest.viewModel.load({ background: true });
    flushSync();

    expect(mounted.target.querySelector('[data-testid="job-status"]')?.textContent).toContain(
      'Encoded',
    );
    // And the result becomes available exactly then.
    expect(mounted.target.querySelector('[data-testid="job-load-output"]')).not.toBeNull();

    mounted.destroy();
  });

  test('the expired result says so and offers no download', async () => {
    // A succeeded job whose bytes aged out. A "Load result" button here would be a
    // fetch that answers 410.
    const { viewModel } = harness([
      job({ status: 'succeeded', outputAvailable: false, updatedAt: 1_700_000_060_000 }),
    ]);

    const mounted = mountJobs(viewModel);
    await tick();
    flushSync();

    expect(mounted.target.querySelector('[data-testid="job-expired"]')).not.toBeNull();
    expect(mounted.target.querySelector('[data-testid="job-load-output"]')).toBeNull();

    mounted.destroy();
  });

  test('a loaded result becomes a playable element, and unmounting releases it', async () => {
    const { viewModel, urls } = harness([
      job({ status: 'succeeded', outputAvailable: true, updatedAt: 1_700_000_060_000 }),
    ]);
    const mounted = mountJobs(viewModel);
    await tick();
    flushSync();

    await viewModel.loadOutput('job_1');
    flushSync();

    const video = mounted.target.querySelector('[data-testid="jobs-video"]');
    expect(video?.getAttribute('src')).toBe('blob:jobs/1');
    expect(mounted.target.querySelector('[data-testid="jobs-player"]')).not.toBeNull();
    expect(urls.revoked).toEqual([]);

    mounted.destroy();
    await tick();

    // The Blob is pinned in memory until this revoke. Without it, every visit to
    // this screen leaks an encoded video for the life of the document.
    expect(urls.revoked).toEqual(['blob:jobs/1']);
  });

  test('unmounting aborts a read in flight', async () => {
    const harnessUnderTest = harness([job({ status: 'running' })]);
    const mounted = mountJobs(harnessUnderTest.viewModel);
    await tick();
    flushSync();

    const deferred = new Deferred<{ jobs: JobDto[]; maintenance: LatestMaintenance }>();
    harnessUnderTest.stall(deferred);
    const inFlight = harnessUnderTest.viewModel.load({ background: true });
    await tick();

    expect(harnessUnderTest.lastSignal?.aborted).toBe(false);
    mounted.destroy();

    // Aborted rather than left to resolve into a component that no longer exists.
    expect(harnessUnderTest.lastSignal?.aborted).toBe(true);
    deferred.resolve({ jobs: [], maintenance: maintenance() });
    await inFlight;
  });

  test('a deployment with jobs switched off offers no retry', async () => {
    // The capability state is not an error with a Try again button: retrying a
    // profile that is off cannot succeed.
    const service = {
      load: async () => {
        throw new AppError('server', 'This deployment has the jobs profile disabled.', {
          status: 503,
        });
      },
    } as unknown as JobsService;
    const viewModel = new JobsViewModel({ jobs: service });

    const mounted = mountJobs(viewModel);
    await tick();
    flushSync();

    const unavailable = mounted.target.querySelector('[data-testid="jobs-unavailable"]');
    expect(unavailable).not.toBeNull();
    expect(mounted.target.querySelector('[data-testid="jobs-unavailable-retry"]')).toBeNull();

    mounted.destroy();
  });

  test('the scheduler evidence is shown with its trigger, not just a timestamp', async () => {
    const run = {
      trigger: 'manual' as const,
      status: 'succeeded' as const,
      slot: null,
      scheduledTime: null,
      startedAt: 1,
      completedAt: 2,
      counts: {
        expiredSessions: 2,
        idleRateLimits: 0,
        artifactsQueued: 0,
        artifactsRetired: 1,
        pendingDispatches: 0,
      },
      errorCode: null,
    };
    const service = {
      load: async () => ({
        jobs: [job()],
        maintenance: {
          schedule: '17 * * * *',
          latest: run,
          latestScheduled: null,
          serverTime: 3,
        } satisfies LatestMaintenance,
      }),
    } as unknown as JobsService;
    const viewModel = new JobsViewModel({ jobs: service });

    const mounted = mountJobs(viewModel);
    await tick();
    flushSync();

    const text =
      mounted.target.querySelector('[data-testid="jobs-maintenance"]')?.textContent ?? '';
    // The sentence a manual run has to produce: the schedule has not fired.
    expect(text).toContain('No scheduled maintenance run yet');
    expect(text).toContain('manually');

    mounted.destroy();
  });
});
