// packages/shared/utils/src/lib/text/slug.test.ts
//
// Slugs and previews.
//
// `slugify` is stated to be total: it never throws and never returns an empty
// string. An empty slug becomes a URL like `/notes/`, which routes to a list page
// instead of a note — a silently wrong destination rather than an error. The
// fallback tests below are the ones that matter.

import { describe, expect, test } from 'bun:test';
import { previewText, slugify } from './slug.ts';

describe('slugify', () => {
  test('lowercases and joins words with a hyphen', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  test('strips diacritics rather than dropping the word', () => {
    // Naive slugifiers turn "Café" into "caf", which collides with the French
    // word "cas".
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('Ångström')).toBe('angstrom');
  });

  test('collapses runs of separators into one hyphen', () => {
    expect(slugify('a   b')).toBe('a-b');
    expect(slugify('a___b')).toBe('a-b');
    expect(slugify('a - b')).toBe('a-b');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('!!!hello!!!')).toBe('hello');
  });

  test('keeps digits', () => {
    expect(slugify('note 42')).toBe('note-42');
  });

  test('falls back when nothing usable remains', () => {
    // The important cases: these all produced an empty slug before the fallback.
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('🎉')).toBe('untitled');
    expect(slugify('中文')).toBe('untitled');
  });

  test('honours a caller-supplied fallback', () => {
    expect(slugify('', 'note')).toBe('note');
    expect(slugify('!!!', 'n')).toBe('n');
  });

  test('bounds the length', () => {
    // A 500-character title must not become a 500-character URL segment.
    const result = slugify('a'.repeat(500));

    expect(result.length).toBeLessThanOrEqual(80);
  });

  test('truncation does not leave a trailing hyphen', () => {
    // Cutting mid-word at the limit used to leave `aaa-`. That is worse than a
    // collision: "aaa-" is not the canonical slug of anything, so the same
    // title produced two different URLs depending on which code path built it.
    const result = slugify(`${'a'.repeat(79)} b`);

    expect(result.endsWith('-')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  test('titles sharing a long prefix collide once truncated', () => {
    // A known limitation, pinned so it is a decision rather than a surprise:
    // these two titles differ only past character 79, so the same bounded slug
    // is correct for both. Nothing here generates slugs as a primary key — a
    // note is addressed by its `id`, and the slug is a label. If a caller ever
    // needs uniqueness, append a short hash of the full title rather than
    // lengthening the limit, which just moves the cliff.
    const first = slugify(`${'a'.repeat(90)} beta`);
    const second = slugify(`${'a'.repeat(90)} gamma`);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(80);
  });

  test('titles differing within the retained prefix stay distinct', () => {
    const first = slugify('shopping list milk bread');
    const second = slugify('shopping list milk eggs');

    expect(first).not.toBe(second);
  });

  test('is deterministic, so the same title always gives the same permalink', () => {
    const title = 'Shopping List: Milk, Bread & Eggs';
    expect(slugify(title)).toBe(slugify(title));
  });

  test('handles emoji alongside words', () => {
    expect(slugify('launch 🚀 today')).toBe('launch-today');
  });
});

describe('previewText', () => {
  test('returns short text unchanged', () => {
    expect(previewText('hello', 10)).toBe('hello');
    // Exactly at the limit is not truncated; the character is not cut.
    expect(previewText('0123456789', 10)).toBe('0123456789');
  });

  test('truncates and marks the cut', () => {
    const result = previewText('0123456789x', 10);

    expect(result.length).toBe(10);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe('012345678…');
  });

  test('does not leave trailing whitespace before the ellipsis', () => {
    // Slicing at the limit can catch a space, producing "word …" in a preview
    // rendered inline.
    const result = previewText('hello world', 6);

    expect(result).toBe('hello…');
  });

  test('never exceeds the requested length', () => {
    for (const maxLength of [1, 2, 5, 20]) {
      expect(previewText('a'.repeat(100), maxLength).length).toBeLessThanOrEqual(maxLength);
    }
  });

  test('handles an empty string', () => {
    expect(previewText('')).toBe('');
  });

  test('defaults to 140 characters', () => {
    expect(previewText('a'.repeat(200)).length).toBe(140);
  });
});
