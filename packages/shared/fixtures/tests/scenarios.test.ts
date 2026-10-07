import { describe, expect, test } from 'bun:test';
import { MOCK_NOTES, UI_SCENARIOS } from '../src/index.ts';

describe('portable UI scenarios', () => {
  test('keeps the existing note fixtures and exposes matching content without generated ids', () => {
    expect(UI_SCENARIOS.notes.empty).toEqual([]);
    expect(UI_SCENARIOS.notes.populated).toEqual(
      MOCK_NOTES.map(({ title, body }) => ({ title, body })),
    );
    expect(JSON.stringify(UI_SCENARIOS.notes)).not.toMatch(/ownerId|createdAt|updatedAt/);
  });

  test('contains long Unicode content and a note that exceeds the schema boundary', () => {
    expect(UI_SCENARIOS.notes.long[0]?.body).toContain('こんにちは');
    expect(UI_SCENARIOS.notes.invalid.title).toHaveLength(121);
  });

  test('describes the deterministic chat and committed media input as serializable data', () => {
    expect(UI_SCENARIOS.chat.prompt.length).toBeGreaterThan(0);
    expect(UI_SCENARIOS.media).toMatchObject({
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      source: 'apps/backend/media/fixtures/media/sample-v1.mp4',
    });
    expect(() => JSON.stringify(UI_SCENARIOS)).not.toThrow();
  });
});
