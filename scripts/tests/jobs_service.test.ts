import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareJobsService } from '../src/local/jobs_service.ts';
import { runScope } from '../src/shared/run_scope.ts';

test('a jobs process that fails to start removes its owned credential file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-start-failure-'));
  const scope = runScope('jobs-fixture', root);
  try {
    await expect(
      prepareJobsService(
        {
          runId: scope.runId,
          scope,
          origin: 'http://127.0.0.1:5173',
          callerVars: {},
          environment: { GOOGLE_DISPATCHER_CREDENTIAL: 'synthetic-fixture' },
        },
        { wranglerBin: () => join(root, 'missing-wrangler') },
      ),
    ).rejects.toThrow('ENOENT');
    expect(await Bun.file(join(scope.dir, 'jobs.dev.vars')).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
