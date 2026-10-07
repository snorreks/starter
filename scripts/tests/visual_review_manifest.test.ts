import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCaptureManifest } from '../src/visual/review.ts';

const config = {
  provider: 'openrouter' as const,
  baseUrl: 'http://127.0.0.1:34567/v1',
  model: 'fixture/vision',
  apiKey: 'fixture-key',
  timeoutMs: 5000,
  maxCalls: 4,
  maxOutputTokens: 1000,
  concurrency: 1,
};

describe('visual review manifest integrity', () => {
  test('refuses an incomplete capture manifest before model configuration or calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visual-review-'));
    try {
      const manifest = join(directory, 'run.json');
      await writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: 1,
          runId: 'run_a',
          status: 'failed',
          expectedCaptures: 1,
          records: [],
        }),
      );
      await expect(reviewCaptureManifest({ manifestPath: manifest, config })).rejects.toThrow(
        'incomplete or failed',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a changed screenshot before it reaches the provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visual-review-'));
    try {
      const image = join(directory, 'capture.png');
      await writeFile(image, Buffer.from('not the declared original'));
      const manifest = join(directory, 'run.json');
      await writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: 1,
          runId: 'run_a',
          status: 'passed',
          expectedCaptures: 1,
          coverageGaps: ['fixture gap'],
          expectedCaptureKeys: ['web-home::desktop-light'],
          records: [
            {
              scenarioId: 'web-home',
              app: 'web',
              state: 'public',
              project: 'desktop-light',
              url: 'http://127.0.0.1/',
              file: image,
              sha256: '0'.repeat(64),
              requirements: ['title-visible'],
              expected: { controls: [], content: [] },
              heading: 'Home',
              status: 'passed',
            },
          ],
        }),
      );
      await expect(reviewCaptureManifest({ manifestPath: manifest, config })).rejects.toThrow(
        'Capture hash mismatch',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
