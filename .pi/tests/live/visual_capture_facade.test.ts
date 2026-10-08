import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-visual-capture-facade-'));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

describe('visual capture through the loaded Pi project tool', () => {
  test(
    'returns a complete, hash-evidenced capture manifest without claiming visual review',
    async () => {
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
        'visual-capture-facade-live',
        { action: 'visual_capture', params: {} },
        undefined,
        undefined,
        { cwd: REPO_ROOT } as never,
      );
      expect(result?.isError).not.toBe(true);
      const response = JSON.parse(
        result?.content[0]?.type === 'text' ? result.content[0].text : '{}',
      ) as {
        operation: string;
        status: string;
        runId: string;
        summary: string;
        artifacts: Array<{ kind: string; sha256: string }>;
        limitations: string[];
      };
      expect(response.operation).toBe('visual-capture');
      expect(response.status).toBe('passed');
      expect(response.runId).toMatch(/^agent_visual_/);
      expect(response.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toHaveLength(
        76,
      );
      expect(response.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(
        true,
      );
      expect(response.summary).toContain('Visual review was NOT RUN.');
    },
    35 * 60_000,
  );
});
