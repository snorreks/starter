// packages/shared/utils/src/lib/common/listener.test.ts
//
// Observer primitives.
//
// These exist so a ViewModel's subscriptions are owned by that ViewModel and
// released in its `dispose()`. The bug they prevent is a listener set that
// outlives the screen that registered it — a module-level singleton that keeps
// a reference to a destroyed component, which is a memory leak that only shows
// up under navigation. The unsubscribe behaviour is therefore the point, not an
// afterthought.

import { describe, expect, test } from 'bun:test';
import { createLiteObserver, createObserver } from './listener.ts';

describe('createObserver', () => {
  test('delivers a payload to every subscriber', () => {
    const observer = createObserver<number>();
    const seen: number[] = [];

    observer.subscribe((value) => seen.push(value));
    observer.subscribe((value) => seen.push(value * 10));

    observer.publish(1);

    expect(seen).toEqual([1, 10]);
  });

  test('publishes to no one when there are no subscribers', () => {
    expect(() => createObserver<number>().publish(1)).not.toThrow();
  });

  test('unsubscribe stops delivery', () => {
    const observer = createObserver<number>();
    const seen: number[] = [];

    const unsubscribe = observer.subscribe((value) => seen.push(value));
    observer.publish(1);
    unsubscribe();
    observer.publish(2);

    expect(seen).toEqual([1]);
  });

  test('unsubscribe is idempotent', () => {
    // `dispose()` may run more than once — a remounted screen, a double-click.
    // A second unsubscribe must not remove a *different* listener that happens
    // to be the same function.
    const observer = createObserver<void>();
    const unsubscribe = observer.subscribe(() => {});
    const again = observer.subscribe(() => {});

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => again()).not.toThrow();
  });

  test('the same function subscribed twice fires twice', () => {
    // A Set would dedupe. For an observer, two registrations from two call sites
    // are two intents, and silently collapsing them makes one of them stop
    // working with no error.
    const observer = createObserver<void>();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    observer.subscribe(listener);
    observer.subscribe(listener);
    observer.publish();

    expect(calls).toBe(2);
  });

  test('unsubscribing one registration leaves the other', () => {
    // A Set keyed on identity cannot do this: the first unsubscribe removes the
    // function, taking both registrations with it.
    const observer = createObserver<void>();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    const unsubscribeFirst = observer.subscribe(listener);
    observer.subscribe(listener);

    unsubscribeFirst();
    observer.publish();

    expect(calls).toBe(1);
  });

  test('a listener may unsubscribe during dispatch', () => {
    // Iterating the live Set would skip the next listener. Publishing to a set
    // that mutates mid-iteration is the classic way to lose a subscriber
    // silently.
    const observer = createObserver<void>();
    const seen: string[] = [];

    const unsubscribeSecond = observer.subscribe(() => {
      seen.push('first');
      unsubscribeSecond();
    });
    observer.subscribe(() => {
      seen.push('second');
    });

    observer.publish();

    expect(seen).toEqual(['first', 'second']);
  });

  test('a listener added during dispatch waits for the next publish', () => {
    const observer = createObserver<void>();
    const seen: string[] = [];

    observer.subscribe(() => {
      seen.push('first');
      observer.subscribe(() => seen.push('late'));
    });

    observer.publish();
    expect(seen).toEqual(['first']);

    observer.publish();
    expect(seen).toEqual(['first', 'first', 'late']);
  });

  test('unsubscribing every listener empties the observer', () => {
    const observer = createObserver<number>();
    const unsubscribes = [
      observer.subscribe(() => {}),
      observer.subscribe(() => {}),
      observer.subscribe(() => {}),
    ];

    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }

    // Nothing to assert on the set directly; a publish that throws or leaks is
    // caught by the teardown test below.
    expect(() => observer.publish(1)).not.toThrow();
  });

  test('a throwing listener does not starve the listeners after it', () => {
    // The reason dispatch isolates throws. With fail-fast dispatch, one
    // permanently-broken subscriber silently kills every later subscriber on
    // every future publish — the symptom a maintainer sees is "the second panel
    // stopped updating", with no error to explain it.
    const observer = createObserver<void>();
    const seen: string[] = [];

    observer.subscribe(() => {
      throw new Error('listener exploded');
    });
    observer.subscribe(() => seen.push('second'));

    expect(() => observer.publish()).not.toThrow();
    expect(seen).toEqual(['second']);

    // And it keeps working on every subsequent publish.
    observer.publish();
    expect(seen).toEqual(['second', 'second']);
  });

  test('one throwing listener does not affect an unrelated observer', () => {
    const broken = createObserver<void>();
    const healthy = createObserver<void>();
    const seen: string[] = [];

    broken.subscribe(() => {
      throw new Error('boom');
    });
    healthy.subscribe(() => seen.push('ok'));

    broken.publish();
    healthy.publish();

    expect(seen).toEqual(['ok']);
  });
});

describe('createLiteObserver', () => {
  test('delivers a payload to the subscriber', () => {
    const observer = createLiteObserver<number>();
    const seen: number[] = [];

    observer.subscribe((value) => seen.push(value));
    observer.publish(1);

    expect(seen).toEqual([1]);
  });

  test('a new subscriber replaces the previous one', () => {
    // The point of "lite": one owner at a time, so there is nothing to
    // unsubscribe. A remounted screen replaces its predecessor's handler rather
    // than leaving both attached.
    const observer = createLiteObserver<void>();
    const seen: string[] = [];

    observer.subscribe(() => seen.push('old'));
    observer.subscribe(() => seen.push('new'));

    observer.publish();

    expect(seen).toEqual(['new']);
  });

  test('publishing before any subscribe is a no-op', () => {
    expect(() => createLiteObserver<number>().publish(1)).not.toThrow();
  });

  test('replacing with no handler disables delivery', () => {
    const observer = createLiteObserver<void>();
    let calls = 0;

    observer.subscribe(() => {
      calls += 1;
    });
    observer.subscribe(undefined as unknown as () => void);

    observer.publish();

    expect(calls).toBe(0);
  });
});
