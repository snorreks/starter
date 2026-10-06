import { describe, expect, test } from 'bun:test';
import { MutationGuard } from './lifecycle_guard.ts';

describe('MutationGuard', () => {
  test('ids increase when overlapping writes finish out of order', () => {
    const guard = new MutationGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first?.id).toBe(1);
    expect(second?.id).toBe(2);
    guard.end();
    const third = guard.begin();
    expect(third?.id).toBe(3);
  });

  test('disposing aborts active writes and refuses new ones', () => {
    const guard = new MutationGuard();
    const active = guard.begin();
    guard.dispose();
    expect(active?.signal.aborted).toBe(true);
    expect(guard.begin()).toBeNull();
  });
});
