import { expect, test } from 'bun:test';
import { requestStructuredVision } from '../src/visual/providers/structured_vision.ts';

const dim = { score: 3, evidence: 'The title is visible.', uncertainty: 'low' };
const review = {
  schemaVersion: 1,
  summary: 'The title is clear.',
  dimensions: Object.fromEntries(
    ['layout', 'typography', 'hierarchy', 'consistency', 'responsiveFit', 'stateClarity'].map(
      (name) => [name, dim],
    ),
  ),
  requirements: [{ id: 'title-visible', status: 'met', evidence: 'The title is visible.' }],
  issues: [],
  reference: null,
};
const options = {
  config: {
    provider: 'openrouter' as const,
    baseUrl: 'http://provider.invalid/v1',
    model: 'fixture/vision',
    apiKey: 'fixture-key',
    timeoutMs: 5000,
    maxCalls: 5,
    maxOutputTokens: 1000,
    concurrency: 1,
  },
  image: { bytes: Buffer.from('fixture'), mimeType: 'image/png' },
  prompt: 'Check the title.',
  requirementIds: ['title-visible'],
};
const success = () =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(review) }, finish_reason: 'stop' }],
  });

test('oversized transient error bodies still retry and recover', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls === 1
      ? new Response('x'.repeat(5000), { status: 503, headers: { 'retry-after': '0' } })
      : success();
  }) as unknown as typeof fetch;
  const response = await requestStructuredVision({ ...options, fetcher });
  expect(response.usage.calls).toBe(2);
  expect(response.review.summary).toBe(review.summary);
});

test.each([400, 503])(
  'oversized HTTP %i errors retain their status and retry bound',
  async (status) => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response('x'.repeat(5000), { status, headers: { 'retry-after': '0' } });
    }) as unknown as typeof fetch;
    await expect(requestStructuredVision({ ...options, fetcher })).rejects.toThrow(
      `HTTP ${status}: Response body unavailable or exceeds 4096 bytes.`,
    );
    expect(calls).toBe(status === 400 ? 1 : 3);
  },
);

test('an absent Retry-After uses the 250ms fallback and refuses a shorter deadline', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls === 1 ? new Response('busy', { status: 503 }) : success();
  }) as unknown as typeof fetch;
  await expect(
    requestStructuredVision({
      ...options,
      config: { ...options.config, timeoutMs: 200 },
      fetcher,
    }),
  ).rejects.toThrow('retry would exceed its total deadline');
  expect(calls).toBe(1);
});

test('choice-level truncation is refused even when the message contains valid JSON', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { content: JSON.stringify(review) }, finish_reason: 'length' }],
    });
  }) as unknown as typeof fetch;
  await expect(requestStructuredVision({ ...options, fetcher })).rejects.toThrow(
    'output was truncated',
  );
  expect(calls).toBe(1);
});
