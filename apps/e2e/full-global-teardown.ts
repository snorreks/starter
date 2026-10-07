import { runBounded } from '../../scripts/src/shared/run_bounded.ts';
import { REPO_ROOT } from '../../scripts/src/shared/paths.ts';

/** The owned runtime host also cleans up on signals; teardown is the final safety net. */
export default async function teardown(): Promise<void> {
  const runId = process.env.E2E_RUN_ID;
  if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) {
    throw new Error('Full E2E teardown cannot identify its owned processor container.');
  }
  const docker = process.env.DOCKER ?? 'docker';
  const name = `starter-e2e-${runId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  const inspect = await runBounded({ command: docker, args: ['container', 'inspect', name], cwd: REPO_ROOT, timeoutMs: 15_000, maxBytes: 64_000 });
  if (inspect.code !== 0) return;
  const remove = await runBounded({ command: docker, args: ['rm', '--force', name], cwd: REPO_ROOT, timeoutMs: 20_000, maxBytes: 64_000 });
  if (remove.code !== 0) throw new Error(`Could not remove owned full-E2E container ${name}: ${remove.stderr.slice(-1000)}`);
}
