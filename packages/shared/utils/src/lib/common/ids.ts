// packages/shared/utils/src/lib/common/ids.ts
//
// Client-generated identifiers. Prefixed so a bare id in a log or a request is
// self-describing, and so an id minted for one domain cannot be mistaken for
// another.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Random base-36 suffix. Uses `crypto.getRandomValues` — available in browsers,
 * Workers and Bun — rather than `Math.random`, so ids are not guessable.
 */
const randomSuffix = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
};

/** Create a new prefixed id, e.g. `note_lz3k9f2a`. */
export const createId = (prefix: string, length = 12): string =>
  `${prefix}_${randomSuffix(length)}`;

/**
 * Create a new prefixed **UUID**, e.g. `msg_6f1c...`.
 *
 * This exists because `createId` is base-36 and a `uuid` column refuses it. The
 * two id kinds look interchangeable until Postgres answers
 * `invalid input syntax for type uuid`, and they are not interchangeable: a text
 * column wants the short sortable-enough id, a uuid column wants a UUID. Anything
 * whose value is stored in a `uuid` column — or passed to a function whose
 * parameter is `uuid` — has to mint its id here.
 *
 * `crypto.randomUUID` rather than a hand-rolled v4: it is the platform's, it is
 * not guessable, and there is nothing to get wrong in it.
 */
export const createUuidId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/** Per-tab id, used to distinguish concurrent clients in one browser. */
export const createClientId = (): string => createId('cli', 10);

export const isIdWithPrefix = (value: string, prefix: string): boolean =>
  value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
