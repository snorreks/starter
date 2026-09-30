// packages/shared/utils/src/lib/text/slug.ts
//
// URL-safe slugs. Used for note permalinks and doc filenames, so it must be
// deterministic and total: never throws, never returns an empty string.

const DIACRITICS = /[̀-ͯ]/g;
const NON_SLUG = /[^a-z0-9]+/g;

const MAX_SLUG_LENGTH = 80;

export const slugify = (input: string, fallback = 'untitled'): string => {
  // Truncation comes before the trim: cutting at the limit can split a word and
  // leave a trailing hyphen, so "aaa… b" and "aaa… c" would both become
  // "aaa…-" — two different titles sharing one permalink.
  const slug = input
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(NON_SLUG, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : fallback;
};

/** A short, human-readable preview of arbitrary text. */
export const previewText = (input: string, maxLength = 140): string =>
  input.length <= maxLength ? input : `${input.slice(0, maxLength - 1).trimEnd()}…`;
