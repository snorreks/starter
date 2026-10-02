// packages/frontend/ui/src/format.ts
//
// Presentation formatting shared by views. Kept out of components so they are
// testable without a DOM and reusable without importing a component.
//
// Moved here from the deleted `@starter/frontend-services` workspace: the only
// consumer in this repository was `note_card.svelte`, and a shared package that
// exists to serve one caller is an indirection with no boundary behind it.

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** "just now", "3 minutes ago", "in 2 days". */
export const formatRelativeTime = (
  timestampMs: number,
  now: number = Date.now(),
  locale = 'en-GB',
): string => {
  const delta = timestampMs - now;
  const magnitude = Math.abs(delta);

  if (magnitude < 45_000) {
    return 'just now';
  }

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (magnitude >= unitMs) {
      return formatter.format(Math.round(delta / unitMs), unit);
    }
  }

  return formatter.format(Math.round(delta / 1000), 'second');
};

/** Absolute, locale-aware timestamp for tooltips and `<time>` elements. */
export const formatAbsoluteTime = (timestampMs: number, locale = 'en-GB'): string =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestampMs));
