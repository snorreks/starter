import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewImage } from '../src/visual/images.ts';
import { requestStructuredVision } from '../src/visual/providers/structured_vision.ts';

const runningServers: Array<{ stop: (force?: boolean) => void }> = [];
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=', 'base64');
const dim = { score: 3, evidence: 'The title is visible.', uncertainty: 'low' as const };
const result = {
  schemaVersion: 1,
  summary: 'The title is clear.',
  dimensions: { layout: dim, typography: dim, hierarchy: dim, consistency: dim, responsiveFit: dim, stateClarity: dim },
  requirements: [{ id: 'title-visible', status: 'met', evidence: 'The title appears at the top.' }],
  issues: [],
  reference: null,
};

afterEach(() => {
  for (const server of runningServers.splice(0)) server.stop(true);
});

const config = (baseUrl: string) => ({
  provider: 'openrouter' as const,
  baseUrl,
  model: 'fixture/vision',
  apiKey: 'fixture-key',
  timeoutMs: 5000,
  maxCalls: 5,
  maxOutputTokens: 1000,
  concurrency: 1,
});

describe('vision provider boundary', () => {
  test('sends an image data part and strict schema, then locally validates the reply', async () => {
    let received: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.headers.get('authorization')).toBe('Bearer fixture-key');
        received = (await request.json()) as Record<string, unknown>;
        return Response.json({
          choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 101, completion_tokens: 52 },
        });
      },
    });
    runningServers.push(server);
    const response = await requestStructuredVision({
      config: config(`http://127.0.0.1:${server.port}/v1`),
      image: { bytes: imageBytes, mimeType: 'image/png' },
      prompt: 'Check the title.',
      requirementIds: ['title-visible'],
    });
    expect(response.review.summary).toBe('The title is clear.');
    expect(response.usage.inputTokens).toBe(101);
    const messages = received?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content.some((part) => part.type === 'image_url')).toBe(true);
    expect(received?.response_format).toBeDefined();
  });

  test('makes at most one schema repair request and includes the image again', async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        calls += 1;
        const payload = (await request.json()) as { messages: Array<{ content: Array<{ type: string }> }> };
        expect(payload.messages[0]?.content.some((part) => part.type === 'image_url')).toBe(true);
        return Response.json({ choices: [{ message: { content: '{"schemaVersion":1}' } }] });
      },
    });
    runningServers.push(server);
    await expect(
      requestStructuredVision({
        config: config(`http://127.0.0.1:${server.port}/v1`),
        image: { bytes: imageBytes, mimeType: 'image/png' },
        prompt: 'Check the title.',
        requirementIds: ['title-visible'],
      }),
    ).rejects.toThrow('after one schema repair');
    expect(calls).toBe(2);
  });

  test('bounds transient retries by the call budget and never retries a valid low score', async () => {
    let calls = 0;
    const unavailable = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        calls += 1;
        return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
      },
    });
    runningServers.push(unavailable);
    await expect(requestStructuredVision({
      config: config(`http://127.0.0.1:${unavailable.port}/v1`),
      image: { bytes: imageBytes, mimeType: 'image/png' },
      prompt: 'Check the title.',
      requirementIds: ['title-visible'],
      callBudget: 2,
    })).rejects.toThrow('call budget');
    expect(calls).toBe(2);

    calls = 0;
    const low = { ...result, dimensions: { ...result.dimensions, layout: { ...dim, score: 0 } } };
    const valid = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        calls += 1;
        return Response.json({ choices: [{ message: { content: JSON.stringify(low) }, finish_reason: 'stop' }] });
      },
    });
    runningServers.push(valid);
    const judgment = await requestStructuredVision({
      config: config(`http://127.0.0.1:${valid.port}/v1`),
      image: { bytes: imageBytes, mimeType: 'image/png' },
      prompt: 'Check the title.',
      requirementIds: ['title-visible'],
    });
    expect(judgment.review.dimensions.layout).toEqual({ ...dim, score: 0 as const });
    expect(calls).toBe(1);
  });

  test('keeps originals unchanged and names unsupported or oversized images', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visual-image-'));
    try {
      const png = join(directory, 'small.png');
      await writeFile(png, imageBytes);
      const prepared = await prepareReviewImage(png);
      expect(prepared.mimeType).toBe('image/png');
      expect(prepared.preparation).toEqual({ backend: 'original', fallbackReasons: [] });
      expect(prepared.originalSha256).toBe(prepared.sha256);
      expect(prepared.derivativePath).toBeNull();
      await expect(prepareReviewImage(png, 10)).rejects.toThrow('exceeds 10 bytes');
      const bad = join(directory, 'bad.bin');
      await writeFile(bad, 'not an image');
      await expect(prepareReviewImage(bad)).rejects.toThrow('Unsupported review image type');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
