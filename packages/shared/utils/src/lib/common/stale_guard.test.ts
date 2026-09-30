// packages/shared/utils/src/lib/common/stale_guard.test.ts
//
// The stale-response guard.
//
// This exists because of one specific bug: a user searches "a", then "ab"; if
// the "a" response arrives second it overwrites the "ab" results. The tests are
// written around ordering and cancellation rather than around the token numbers,
// because a token that merely increments correctly but is never *checked* still
// produces the bug.

import { describe, expect, test } from 'bun:test';
import { StaleGuard } from './stale_guard.ts';

describe('StaleGuard', () => {
  test('the first operation is current', () => {
    const guard = new StaleGuard();

    const operation = guard.begin();

    expect(guard.isCurrent(operation.token)).toBe(true);
  });

  test('a superseded operation is no longer current', () => {
    const guard = new StaleGuard();

    const first = guard.begin();
    guard.begin();

    expect(guard.isCurrent(first.token)).toBe(false);
  });

  test('the newest operation is current', () => {
    const guard = new StaleGuard();

    guard.begin();
    const last = guard.begin();

    expect(guard.isCurrent(last.token)).toBe(true);
  });

  test('tokens are unique across a long sequence', () => {
    // A repeated token would let a very old response look current again.
    const guard = new StaleGuard();

    const tokens = new Set<number>();
    for (let index = 0; index < 500; index += 1) {
      tokens.add(guard.begin().token);
    }

    expect(tokens.size).toBe(500);
  });

  test('beginning a new operation aborts the previous signal', () => {
    // Cancellation, not just ignoring. An ignored request still occupies a
    // connection and still consumes server work.
    const guard = new StaleGuard();

    const first = guard.begin();
    expect(first.signal.aborted).toBe(false);

    guard.begin();
    expect(first.signal.aborted).toBe(true);
  });

  test('the newest signal is not aborted by its own creation', () => {
    const guard = new StaleGuard();

    const latest = guard.begin();

    expect(latest.signal.aborted).toBe(false);
  });

  test('a cancelled signal actually cancels a real fetch', () => {
    // The point of an AbortSignal: a real in-flight request stops. Asserting only
    // on `.aborted` would pass even if nothing consumed the signal.
    const guard = new StaleGuard();
    const { signal } = guard.begin();

    const aborted = new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(true), { once: true });
    });

    guard.begin();

    return expect(aborted).resolves.toBe(true);
  });

  test('cancelAll invalidates an outstanding token', () => {
    const guard = new StaleGuard();
    const operation = guard.begin();

    guard.cancelAll();

    expect(guard.isCurrent(operation.token)).toBe(false);
    expect(guard.cancelled).toBe(true);
  });

  test('cancelAll aborts the in-flight signal', () => {
    const guard = new StaleGuard();
    const { signal } = guard.begin();

    guard.cancelAll();

    expect(signal.aborted).toBe(true);
  });

  test('a new operation after cancelAll is current again', () => {
    // A screen that is remounted reuses the guard. If this did not reset, the
    // remounted screen would discard every response it ever received.
    const guard = new StaleGuard();
    guard.cancelAll();

    const operation = guard.begin();

    expect(guard.cancelled).toBe(false);
    expect(guard.isCurrent(operation.token)).toBe(true);
  });

  test('a token from before cancelAll stays invalid', () => {
    // Clearing the cancelled flag must not resurrect old tokens.
    const guard = new StaleGuard();
    const beforeCancel = guard.begin().token;

    guard.cancelAll();
    guard.begin();

    expect(guard.isCurrent(beforeCancel)).toBe(false);
  });

  test('cancelAll is safe with nothing in flight', () => {
    const guard = new StaleGuard();

    expect(() => guard.cancelAll()).not.toThrow();
    expect(guard.cancelled).toBe(true);
  });

  test('repeated cancelAll stays consistent', () => {
    const guard = new StaleGuard();
    guard.begin();

    guard.cancelAll();
    guard.cancelAll();

    expect(guard.cancelled).toBe(true);
  });

  test('models the search race it exists to prevent', async () => {
    // The end-to-end shape: three overlapping requests resolving out of order,
    // and only the newest allowed to write.
    const guard = new StaleGuard();
    const accepted: string[] = [];

    const search = async (term: string, delayMs: number): Promise<void> => {
      const operation = guard.begin();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Deliberately inverted: the *later* term resolves *first*.
      if (guard.isCurrent(operation.token)) {
        accepted.push(term);
      }
    };

    await Promise.all([search('a', 30), search('ab', 20), search('abc', 10)]);

    expect(accepted).toEqual(['abc']);
  });

  test('a superseded request resolves without writing, even after the newest', async () => {
    const guard = new StaleGuard();
    let displayed = '';

    const load = async (value: string, delayMs: number): Promise<void> => {
      const operation = guard.begin();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (guard.isCurrent(operation.token)) {
        displayed = value;
      }
    };

    const stale = load('old', 40);
    const fresh = load('new', 5);
    await Promise.all([stale, fresh]);

    expect(displayed).toBe('new');
  });

  test('two guards are independent', () => {
    // Two screens on one page each have their own guard; a shared one would let
    // one screen's request cancel another's.
    const first = new StaleGuard();
    const second = new StaleGuard();

    const firstOperation = first.begin();
    second.begin();

    expect(first.isCurrent(firstOperation.token)).toBe(true);
  });
});
