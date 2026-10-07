import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import repoTaskExtension from '../extensions/repo_task.ts';
import { runScope } from '../../scripts/src/shared/run_scope.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

test('repo_task imports a verified interactive browser capture through the project CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-task-visual-import-'));
  scratch.push(directory);
  const file = join(directory, 'current-state.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(file, png);
  const runId = `pi_interactive_${randomUUID().replaceAll('-', '')}`;
  const scope = runScope(runId, REPO_ROOT);
  scratch.push(scope.dir);
  let tool:
    | {
        execute: (
          id: string,
          params: unknown,
          signal?: AbortSignal,
          update?: unknown,
          context?: unknown,
        ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
      }
    | undefined;
  repoTaskExtension({
    registerTool: (registered: typeof tool) => {
      tool = registered;
    },
  } as unknown as ExtensionAPI);

  const result = await tool?.execute('interactive-import', {
    action: 'visual_import',
    params: {
      runId,
      file,
      sha256: createHash('sha256').update(png).digest('hex'),
      url: 'http://127.0.0.1:4173/notes',
      heading: 'Notes',
      requirements: ['The saved note is visible.'],
      controls: ['Save'],
      content: ['A saved note'],
      viewport: 'desktop',
      theme: 'light',
    },
  });
  expect(result?.isError, result?.content[0]?.text).toBeFalsy();
  const body = JSON.parse(result?.content[0]?.text ?? '{}');
  expect(body).toMatchObject({
    operation: 'visual-import',
    status: 'passed',
    runId,
    capture: {
      url: 'http://127.0.0.1:4173/notes',
      captureKind: 'interactive',
      originalSha256: createHash('sha256').update(png).digest('hex'),
    },
    rerun: [`bun run agent -- visual review --run ${runId} --json`],
  });
  expect(body.limitations[0]).toContain('exploratory');
});
