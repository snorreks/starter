// packages/shared/utils/src/lib/text/slug.ts
//
// URL-safe slugs. Used for note permalinks and doc filenames, so it must be
// deterministic and total: never throws, never returns an empty string.

const DIACRITICS = /[̀-ͯ]/g;
const NON_SLUG = /[^a-z0-9]+/g;

export const slugify = (input: string, fallback = 'untitled'): string => {
  const slug = input
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(NON_SLUG, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug.length > 0 ? slug : fallback;
};

/** A short, human-readable preview of arbitrary text. */
export const previewText = (input: string, maxLength = 140): string =>
  input.length <= maxLength ? input : `${input.slice(0, maxLength - 1).trimEnd()}…`;
