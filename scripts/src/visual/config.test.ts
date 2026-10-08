import { describe, expect, test } from 'bun:test';
import { loadVisionConfig } from './config.ts';

describe('visual provider credential source', () => {
  test('uses the global OpenRouter key when no dedicated visual key is configured', () => {
    const config = loadVisionConfig({
      E2E_VISION_MODEL: 'google/gemini-2.5-flash',
      E2E_VISION_API_KEY: '',
      OPENROUTER_API_KEY: 'global-fixture-key',
    });

    expect(config).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      apiKey: 'global-fixture-key',
    });
  });

  test('lets a dedicated visual key override the global provider key', () => {
    const config = loadVisionConfig({
      E2E_VISION_MODEL: 'google/gemini-2.5-flash',
      E2E_VISION_API_KEY: 'dedicated-fixture-key',
      OPENROUTER_API_KEY: 'global-fixture-key',
    });

    expect(config.apiKey).toBe('dedicated-fixture-key');
  });

  test('reports unavailable when neither source supplies a key', () => {
    expect(() =>
      loadVisionConfig({
        E2E_VISION_MODEL: 'google/gemini-2.5-flash',
        E2E_VISION_API_KEY: '',
        OPENROUTER_API_KEY: '',
      }),
    ).toThrow('OPENROUTER_API_KEY in the global environment');
  });
});
