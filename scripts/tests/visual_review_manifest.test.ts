import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

test('changed expected content invalidates a cached judgment for the same image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-review-cache-'));
  const prompts: string[] = [];
  const dim = { score: 3, evidence: 'The title is visible.', uncertainty: 'low' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as {
        messages: Array<{ content: Array<{ text?: string }> }>;
      };
      prompts.push(payload.messages[0]?.content[0]?.text ?? '');
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                summary: 'The title is clear.',
                dimensions: Object.fromEntries(
                  [
                    'layout',
                    'typography',
                    'hierarchy',
                    'consistency',
                    'responsiveFit',
                    'stateClarity',
                  ].map((name) => [name, dim]),
                ),
                requirements: [
                  { id: 'title-visible', status: 'met', evidence: 'The title is visible.' },
                ],
                issues: [],
                reference: null,
              }),
            },
            finish_reason: 'stop',
          },
        ],
      });
    },
  });
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=',
      'base64',
    );
    const image = join(directory, 'capture.png');
    await writeFile(image, bytes);
    const record = {
      scenarioId: `cache-${crypto.randomUUID()}`,
      app: 'web',
      state: 'public',
      project: 'desktop-light',
      url: 'http://127.0.0.1/',
      file: image,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      requirements: ['title-visible'],
      expected: { controls: [], content: ['Original content'] },
      heading: 'Home',
      status: 'passed',
    };
    const manifestPath = join(directory, 'run.json');
    const writeManifest = () =>
      writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: 'cache-test',
          status: 'passed',
          expectedCaptures: 1,
          coverageGaps: ['fixture gap'],
          expectedCaptureKeys: [`${record.scenarioId}::desktop-light`],
          records: [record],
        }),
      );
    const options = {
      manifestPath,
      config: { ...config, baseUrl: `http://127.0.0.1:${server.port}/v1` },
    };
    await writeManifest();
    expect((await reviewCaptureManifest(options)).cached).toBe(0);
    expect((await reviewCaptureManifest(options)).cached).toBe(1);
    record.expected.content = ['Changed content'];
    await writeManifest();
    expect((await reviewCaptureManifest(options)).cached).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Original content');
    expect(prompts[1]).toContain('Changed content');
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
