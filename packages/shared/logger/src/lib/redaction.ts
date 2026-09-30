// packages/shared/logger/src/lib/redaction.ts
//
// Default-deny redaction applied on every path that can emit data outside the
// current process: the logger, the Worker telemetry endpoint and the log CLI.
//
// Field-name based rather than value-pattern based on purpose — pattern
// matching over free text produces false negatives (a token in a sentence) and
// false positives (a "token" count), and both are worse than an explicit list.

/** Field names whose values are replaced before leaving the process. */
export const DEFAULT_REDACTED_KEYS = [
  'password',
  'passwordhash',
  'passwordHash',
  'token',
  'accesstoken',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'auth',
  'cookie',
  'setCookie',
  'set-cookie',
  'secret',
  'clientSecret',
  'apiKey',
  'api_key',
  'privateKey',
  'sessionToken',
  'credential',
  'credentials',
  'assertion',
  'otp',
  'code',
  'ssn',
] as const;

export const REDACTED = '[redacted]';

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const DEFAULT_REDACTED_SET = new Set(DEFAULT_REDACTED_KEYS.map(normalise));

export const isRedactedKey = (key: string, extra: readonly string[] = []): boolean => {
  const normalised = normalise(key);
  if (DEFAULT_REDACTED_SET.has(normalised)) {
    return true;
  }
  return extra.some((candidate) => normalise(candidate) === normalised);
};

export interface RedactOptions {
  extraKeys?: readonly string[];
  /** Max depth walked before the value is summarized instead of copied. */
  maxDepth?: number;
  /** Max entries retained per object/array. */
  maxEntries?: number;
  /** Max string length retained. */
  maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_STRING = 2000;

/**
 * Returns a redacted, depth- and size-bounded deep copy.
 *
 * Never throws and never recurses without a bound: this runs on the logging
 * path, where a cyclic or adversarial payload must not be able to hang or blow
 * the stack of the process that is trying to report the problem.
 */
export const redactValue = (value: unknown, options: RedactOptions = {}): unknown => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === 'string') {
      return input.length > maxStringLength
        ? `${input.slice(0, maxStringLength)}…[${input.length} chars]`
        : input;
    }

    if (typeof input === 'number' || typeof input === 'boolean') {
      return input;
    }

    if (typeof input === 'bigint') {
      return `${input.toString()}n`;
    }

    if (typeof input === 'function') {
      return `[function ${input.name || 'anonymous'}]`;
    }

    if (typeof input === 'symbol') {
      return input.toString();
    }

    if (input instanceof Error) {
      // `name`, `message` and `stack` are read defensively: an Error subclass
      // can define any of them as a getter that throws, and this is still the
      // logging path.
      const read = (field: 'name' | 'message' | 'stack'): string | undefined => {
        try {
          const value: unknown = input[field];
          return typeof value === 'string' ? value : undefined;
        } catch {
          return undefined;
        }
      };

      const name = read('name') ?? 'Error';
      const message = read('message') ?? '';
      const stack = read('stack');

      return {
        name,
        message,
        ...(stack === undefined ? {} : { stack: stack.split('\n').slice(0, 10).join('\n') }),
      };
    }

    if (typeof input !== 'object') {
      return `[${typeof input}]`;
    }

    if (seen.has(input)) {
      return '[circular]';
    }

    if (depth >= maxDepth) {
      return Array.isArray(input) ? '[array]' : '[object]';
    }

    seen.add(input);

    try {
      if (Array.isArray(input)) {
        const kept = input.slice(0, maxEntries).map((entry) => walk(entry, depth + 1));
        if (input.length > maxEntries) {
          kept.push(`…${input.length - maxEntries} more`);
        }
        return kept;
      }

      const result: Record<string, unknown> = {};
      // `Object.keys` and the property read are both outside the caller's
      // control: a Proxy, or a getter that throws, would otherwise propagate out
      // of the logging path and take down the process that is trying to report
      // something else. A missing field is worth a log line; a crashed request
      // handler is not.
      let keys: string[];
      try {
        keys = Object.keys(input).slice(0, maxEntries);
      } catch {
        return '[unreadable object]';
      }

      for (const key of keys) {
        if (isRedactedKey(key, options.extraKeys)) {
          result[key] = REDACTED;
          continue;
        }
        let entry: unknown;
        try {
          entry = (input as Record<string, unknown>)[key];
        } catch {
          result[key] = '[unreadable]';
          continue;
        }
        result[key] = walk(entry, depth + 1);
      }

      let total: number;
      try {
        total = Object.keys(input).length;
      } catch {
        return result;
      }
      if (total > maxEntries) {
        result['…'] = `${total - maxEntries} more keys`;
      }
      return result;
    } finally {
      seen.delete(input);
    }
  };

  return walk(value, 0);
};
