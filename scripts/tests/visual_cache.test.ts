import { expect, test } from 'bun:test';
import { reviewCacheKey } from '../src/visual/cache.ts';

test('validated judgment cache identity changes with image, reference, endpoint, model, prompt, schema and grading inputs', () => {
  const base = {
    sha256: 'a'.repeat(64),
    sentSha256: 'b'.repeat(64),
    referenceSha256: null,
    prompt: 'rubric-1',
    schema: 1,
    requirements: ['primary-action'],
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    model: 'vision/model-a',
    options: { maxOutputTokens: 2500, preparation: 'original-preserved' },
  };
  const key = reviewCacheKey(base);
  for (const changed of [
    { ...base, sha256: 'c'.repeat(64) },
    { ...base, referenceSha256: 'd'.repeat(64) },
    { ...base, endpoint: 'https://example.test/v1' },
    { ...base, model: 'vision/model-b' },
    { ...base, prompt: 'rubric-2' },
    { ...base, schema: 2 },
    { ...base, requirements: ['primary-action', 'footer'] },
    { ...base, options: { ...base.options, maxOutputTokens: 3000 } },
  ]) {
    expect(reviewCacheKey(changed)).not.toBe(key);
  }
});
