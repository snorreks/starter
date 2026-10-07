import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-compute-facade-'));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

describe('full compute through the loaded Pi project tool', () => {
  test(
    'starts the real browser-to-FFmpeg journey and returns hash-verified output evidence',
    async () => {
      const settingsManager = SettingsManager.create(REPO_ROOT, agentDir);
      settingsManager.setProjectTrusted(true);
      const loader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir,
        settingsManager,
      });
      await loader.reload();
      const load = loader.getExtensions();
      expect(load.errors).toEqual([]);
      const tool = load.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .find((candidate) => candidate.definition?.name === 'repo_task')?.definition;
      expect(tool?.execute).toBeFunction();

      const result = await tool?.execute(
        'compute-facade-live',
        { action: 'compute_full', params: {} },
        undefined,
        undefined,
        { cwd: REPO_ROOT } as never,
      );
      expect(result?.isError).toBeFalsy();
      const response = JSON.parse(
        result?.content[0]?.type === 'text' ? result.content[0].text : '{}',
      ) as {
        operation?: string;
        status?: string;
        runId?: string;
        artifacts?: Array<{ kind: string; sha256: string; bytes: number }>;
        evidence?: { probe?: { codec?: string; width?: number; height?: number } };
      };
      expect(response).toMatchObject({
        operation: 'compute-full',
        status: 'passed',
        evidence: { probe: { codec: 'h264', width: 320, height: 180 } },
      });
      expect(response.runId).toMatch(/^agent_full_/);
      expect(response.artifacts).toHaveLength(2);
      expect(response.artifacts?.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(
        true,
      );
    },
    40 * 60_000,
  );
});
