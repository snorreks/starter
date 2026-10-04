// apps/frontend/native/src/lib/platform/app_activity.test.ts
//
// The rule, against a fake target rather than a window.
//
// The behaviours that matter are the three disagreements this module exists to
// collapse: a hidden-but-focused document (a minimised window), a visible-but-
// blurred one (a window behind another), and neither. A `visibilityState`-only
// implementation gets the second one wrong, and it gets it wrong in the direction
// that keeps polling for a user who cannot see the screen.
//
// No webview and no Tauri: the target is structural, which is why this file can
// assert the rule in the package's own Bun lane.

import { describe, expect, test } from 'bun:test';
import { type ActivityTarget, isActive, watchAppActivity } from './app_activity.ts';

class FakeTarget implements ActivityTarget {
  visibilityState = 'visible';
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('isActive', () => {
  test('visible and focused is active', () => {
    expect(isActive(new FakeTarget(), true)).toBe(true);
  });

  test('visible but not focused is not active', () => {
    // A window behind another one still reports itself visible. Reporting that as
    // active is how a backgrounded app keeps polling for a user who cannot see it.
    expect(isActive(new FakeTarget(), false)).toBe(false);
  });

  test('hidden is not active even when focused', () => {
    const target = new FakeTarget();
    target.visibilityState = 'hidden';
    expect(isActive(target, true)).toBe(false);
  });
});

describe('watchAppActivity', () => {
  test('it reports the current state before any event', () => {
    // The effect that wires this starts from the right answer rather than from an
    // assumption, which matters when the window is already behind another one.
    const target = new FakeTarget();
    const seen: boolean[] = [];

    watchAppActivity((active) => seen.push(active), target);

    expect(seen).toEqual([true]);
  });

  test('losing focus is reported even though visibility did not change', () => {
    const target = new FakeTarget();
    const seen: boolean[] = [];
    watchAppActivity((active) => seen.push(active), target);

    target.emit('blur');
    target.emit('focus');

    expect(seen).toEqual([true, false, true]);
  });

  test('a hidden document is reported inactive and visible again on return', () => {
    const target = new FakeTarget();
    const seen: boolean[] = [];
    watchAppActivity((active) => seen.push(active), target);

    target.visibilityState = 'hidden';
    target.emit('visibilitychange');
    target.visibilityState = 'visible';
    target.emit('visibilitychange');

    expect(seen).toEqual([true, false, true]);
  });

  test('unsubscribing detaches every listener', () => {
    // An effect cleanup runs on every navigation; three listeners per visit left
    // behind would report each state change three times.
    const target = new FakeTarget();
    const seen: boolean[] = [];

    const stop = watchAppActivity((active) => seen.push(active), target);
    stop();

    expect(target.count('visibilitychange')).toBe(0);
    expect(target.count('focus')).toBe(0);
    expect(target.count('blur')).toBe(0);

    target.emit('blur');
    expect(seen).toEqual([true]);
  });
});
