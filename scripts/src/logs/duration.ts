// scripts/src/lib/logs/duration.ts
//
// Duration parsing for `--since` and `--duration`.
//
// Small, total, and unit-tested: a duration parser that silently returns 0 for
// an unrecognised string turns "show me the last 30 minutes" into "show me
// everything" or "show me nothing", and both look like a working command
// returning no data.

export interface ParsedDuration {
  ms: number;
  label: string;
}

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i;

/** Parse `30m`, `2h`, `1.5d`, `45s`. Returns `null` when unrecognised. */
export const parseDuration = (input: string | undefined): ParsedDuration | null => {
  if (input === undefined) {
    return null;
  }

  const match = DURATION_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || unit === undefined) {
    return null;
  }

  const ms = Math.round(amount * unit);
  return { ms, label: `${match[1]}${match[2].toLowerCase()}` };
};

export const describeDurationUnits = (): string =>
  Object.keys(UNITS)
    .map((unit) => `${unit} (${UNITS[unit] / 1000}s)`)
    .join(', ');
