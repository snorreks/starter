import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-visual-review-facade-'));
const runId = process.env.PI_VISUAL_REVIEW_RUN_ID;
if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) {
  throw new Error(
    'Set PI_VISUAL_REVIEW_RUN_ID to a previously reviewed run for this cached comparison.',
  );
}
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

describe('visual review through the loaded Pi project tool', () => {
  test(
    'matches the project CLI grade and provider/model provenance on the same cached run',
    async () => {
      const cli = spawnSync(
        'bun',
        ['run', 'agent', '--', 'visual', 'review', '--run', runId, '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20 * 60_000 },
      );
      expect(cli.error).toBeUndefined();
      expect(cli.status === 0 || cli.status === 1).toBe(true);
      const cliResponse = JSON.parse(cli.stdout) as {
        operation: string;
        status: string;
        runId: string;
        provenance: Array<Record<string, unknown>>;
        error?: unknown;
      };
      expect(cliResponse.error).toBeUndefined();

      const settingsManager = SettingsManager.create(REPO_ROOT, agentDir);
      settingsManager.setProjectTrusted(true);
      const loader = new DefaultResourceLoader({ cwd: REPO_ROOT, agentDir, settingsManager });
      await loader.reload();
      const load = loader.getExtensions();
      expect(load.errors).toEqual([]);
      const tool = load.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .find((candidate) => candidate.definition?.name === 'repo_task')?.definition;
      expect(tool?.execute).toBeFunction();

      const result = await tool?.execute(
        'visual-review-facade-live',
        { action: 'visual_review', params: { runId } },
        undefined,
        undefined,
        { cwd: REPO_ROOT } as never,
      );
      expect(result?.isError).toBe(cli.status !== 0);
      const piResponse = JSON.parse(
        result?.content[0]?.type === 'text' ? result.content[0].text : '{}',
      ) as typeof cliResponse;
      expect(piResponse.operation).toBe('review');
      expect(piResponse.runId).toBe(cliResponse.runId);
      expect(piResponse.status).toBe(cliResponse.status);
      expect(piResponse.provenance).toEqual(cliResponse.provenance);
      expect(piResponse.provenance).toHaveLength(76);
    },
    25 * 60_000,
  );
});
