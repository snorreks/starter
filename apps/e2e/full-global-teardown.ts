import { REPO_ROOT } from '../../scripts/src/shared/paths.ts';
import { runBounded } from '../../scripts/src/shared/run_bounded.ts';
import { publicToolEnvironment } from '../../scripts/src/shared/private_environment.ts';

/** Discover only this run's labelled finite containers, including failed Docker supervision. */
export const removeOwnedFullContainers = async (runId: string): Promise<void> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) {
    throw new Error('Full E2E teardown cannot identify its owned processor container.');
  }
  const docker = process.env.DOCKER ?? 'docker';
  const inspect = await runBounded({
    command: docker,
    args: ['ps', '--all', '--quiet', '--filter', `label=starter.e2e.run=${runId}`],
    cwd: REPO_ROOT,
    timeoutMs: 15_000,
    maxBytes: 64_000,
    env: publicToolEnvironment(process.env),
  });
  if (inspect.code !== 0) {
    throw new Error(`Could not discover this run's finite containers (${inspect.code}).`);
  }
  const ids = inspect.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length > 64 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) {
    throw new Error('Docker returned an invalid or unbounded owned container list.');
  }
  for (const id of ids) {
    const remove = await runBounded({
      command: docker,
      args: ['rm', '--force', id],
      cwd: REPO_ROOT,
      timeoutMs: 20_000,
      maxBytes: 64_000,
      env: publicToolEnvironment(process.env),
    });
    if (remove.code !== 0 && !remove.stderr.includes(`No such container: ${id}`)) {
      throw new Error(`Could not remove owned full-E2E container ${id} (${remove.code}).`);
    }
  }
};

/** The runtime also cleans up on signals; this is the final run-scoped safety net. */
const teardown = async (): Promise<void> => {
  const runId = process.env.E2E_RUN_ID;
  if (runId === undefined) {
    throw new Error('Full E2E teardown requires its owned run id.');
  }
  await removeOwnedFullContainers(runId);
};
export default teardown;
