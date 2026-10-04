import { describe, expect, mock, test } from 'bun:test';
import type { LatestMaintenance } from '@starter/schemas/jobs';
import type { JobsService, ListJobsOutcome } from '../src/lib/server/jobs_service.ts';
import { load } from '../src/routes/jobs/+page.server.ts';

const maintenance: LatestMaintenance = {
  schedule: '17 * * * *',
  latest: null,
  latestScheduled: null,
  serverTime: 1,
};

const fixture = (outcome: ListJobsOutcome) => {
  const list = mock(async () => outcome);
  const latestMaintenance = mock(async () => ({ ok: true as const, latest: maintenance }));
  const event = {
    locals: {
      user: { id: 'owner' },
      container: {
        jobsProfile: 'encode',
        jobs: { list, latestMaintenance } as unknown as JobsService,
      },
    },
  } as Parameters<typeof load>[0];
  return { event, list, latestMaintenance };
};

describe('jobs page server load', () => {
  test('a failed list raises its HTTP error instead of rendering an empty list', async () => {
    const { event, latestMaintenance } = fixture({
      ok: false,
      code: 'invalid_cursor',
      detail: 'Invalid jobs cursor.',
    });

    await expect(load(event)).rejects.toMatchObject({
      status: 400,
      body: { message: 'Invalid jobs cursor.' },
    });
    expect(latestMaintenance).not.toHaveBeenCalled();
  });

  test('a successful list retains the jobs and maintenance evidence', async () => {
    const jobs = [
      {
        id: 'job_1',
        kind: 'encode' as const,
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1,
        outputAvailable: false,
        errorCode: null,
      },
    ];
    const { event, list, latestMaintenance } = fixture({
      ok: true,
      page: { jobs, nextCursor: null, serverTime: 1 },
    });

    expect(await load(event)).toMatchObject({ profile: 'encode', jobs, maintenance });
    expect(list).toHaveBeenCalledWith('owner');
    expect(latestMaintenance).toHaveBeenCalledTimes(1);
  });
});
