// packages/shared/live/src/polling.test.ts
//
// Every test here drives a fake scheduler and asserts on *when* something fired,
// because the property worth protecting is not "does it poll" — it is "does it
// stop, does it widen, and does it come back". A test that awaited real timers
// would prove all three badly and slowly.

import { describe, expect, test } from 'bun:test';
import type { LiveScheduler } from './contract.ts';
import { createManualLiveUpdates, createPollingLiveUpdates } from './polling.ts';

interface Harness {
  readonly scheduler: LiveScheduler;
  /** Timers still armed. Zero is the assertion several tests turn on. */
  armed(): number;
  /** Move time forward, firing everything now due, in due order. */
  advance(ms: number): void;
}

/**
 * Counts what this file registers.
 *
 * `bun:test` in this version exports no way to enumerate collected tests, so the
 * count is taken at registration time instead. That works because every `test`
 * call in the module body runs during collection, before any test body executes,
 * so by the time the assertion below runs the number is already final.
 */
const registered: string[] = [];

/** `test`, counted. Every case below goes through this rather than the import. */
const spec = (name: string, body: () => void | Promise<void>): void => {
  registered.push(name);
  test(name, body);
};

const harness = (): Harness => {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { handler: () => void; at: number }>();
  return {
    scheduler: {
      setTimeout(handler, ms) {
        const id = nextId++;
        pending.set(id, { handler, at: now + ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    armed: () => pending.size,
    advance(ms) {
      now += ms;
      // Re-checked each pass: a handler arms the next timer, so one pass is not
      // enough to drain a chain that keeps rescheduling.
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) {
          return;
        }
        for (const [id, timer] of due) {
          pending.delete(id);
          timer.handler();
        }
      }
    },
  };
};

describe('a poll that is not being watched', () => {
  spec('stops asking once the last subscriber closes', () => {
    const time = harness();
    const live = createPollingLiveUpdates({ scheduler: time.scheduler });
    let notified = 0;
    const subscription = live.subscribe('conversation:a', () => {
      notified += 1;
    });

    time.advance(60_000);
    expect(notified).toBeGreaterThan(0);

    subscription.close();
    expect(time.armed()).toBe(0);

    const before = notified;
    time.advance(60_000);
    expect(notified).toBe(before);
  });

  spec('keeps polling while any subscriber remains', () => {
    const time = harness();
    const live = createPollingLiveUpdates({ scheduler: time.scheduler });
    const first = live.subscribe('conversation:a', () => undefined);
    live.subscribe('conversation:b', () => undefined);

    first.close();
    expect(time.armed()).toBe(1);

    live.close();
    expect(time.armed()).toBe(0);
  });
});

describe('the interval between reads', () => {
  spec('widens while nothing changed and returns to the floor when something did', () => {
    const time = harness();
    const live = createPollingLiveUpdates({
      scheduler: time.scheduler,
      baseMs: 1_000,
      maxMs: 60_000,
      backoff: 2,
    });
    const firedAt: number[] = [];
    let now = 0;
    const subscription = live.subscribe('conversation:a', () => {
      firedAt.push(now);
    });
    const step = (ms: number): void => {
      now += ms;
      time.advance(ms);
    };

    step(1_000); // fires at 1000
    step(2_000); // widened: fires at 3000
    step(4_000); // widened again: fires at 7000

    // Gaps between consecutive reads must be growing.
    expect(firedAt[1] - firedAt[0]).toBe(2_000);
    expect(firedAt[2] - firedAt[1]).toBe(4_000);

    // A read that found something collapses the interval to the floor, and does
    // so immediately rather than after the already-armed long wait.
    subscription.notifyChanged();
    step(1_000);
    expect(firedAt[3] - firedAt[2]).toBe(1_000);

    live.close();
  });

  spec('never waits longer than the ceiling, however long it stays idle', () => {
    const time = harness();
    const live = createPollingLiveUpdates({
      scheduler: time.scheduler,
      baseMs: 1_000,
      maxMs: 4_000,
      backoff: 10,
    });
    let now = 0;
    const firedAt: number[] = [];
    const subscription = live.subscribe('conversation:a', () => {
      firedAt.push(now);
    });

    for (let i = 0; i < 12; i += 1) {
      now += 4_000;
      time.advance(4_000);
    }
    expect(firedAt.length).toBeGreaterThan(2);
    for (let i = 1; i < firedAt.length; i += 1) {
      expect(firedAt[i] - firedAt[i - 1]).toBeLessThanOrEqual(4_000);
    }

    subscription.close();
    live.close();
  });
});

describe('a screen that tears itself down', () => {
  spec('is never called again after closing inside its own callback', () => {
    const time = harness();
    const live = createPollingLiveUpdates({
      scheduler: time.scheduler,
      baseMs: 1_000,
      backoff: 1,
    });
    let notified = 0;
    const subscription = live.subscribe('conversation:a', () => {
      notified += 1;
      subscription.close();
    });

    time.advance(10_000);
    expect(notified).toBe(1);
    expect(time.armed()).toBe(0);
  });

  spec('is not called at all after the transport is closed', () => {
    const time = harness();
    const live = createPollingLiveUpdates({ scheduler: time.scheduler });
    let notified = 0;
    live.subscribe('conversation:a', () => {
      notified += 1;
    });

    live.close();
    live.close(); // idempotent
    time.advance(60_000);

    expect(notified).toBe(0);
    expect(time.armed()).toBe(0);
  });

  spec('subscribing after close yields a handle that does nothing', () => {
    const time = harness();
    const live = createPollingLiveUpdates({ scheduler: time.scheduler });
    live.close();

    let notified = 0;
    const subscription = live.subscribe('conversation:a', () => {
      notified += 1;
    });
    subscription.notifyChanged();
    subscription.close();
    live.refresh();
    time.advance(60_000);

    expect(notified).toBe(0);
  });
});

describe('a tab that was hidden', () => {
  spec('holds no timer while nobody is looking, and refreshes once on return', () => {
    const time = harness();
    let active = false;
    const live = createPollingLiveUpdates({
      scheduler: time.scheduler,
      isActive: () => active,
      baseMs: 1_000,
      backoff: 1,
    });
    let notified = 0;
    live.subscribe('conversation:a', () => {
      notified += 1;
    });

    expect(time.armed()).toBe(0);
    time.advance(30_000);
    expect(notified).toBe(0);

    active = true;
    live.refresh();
    expect(notified).toBe(1);
    expect(time.armed()).toBe(1);
  });
});

describe('what a screen is told about liveness', () => {
  spec('reports the mode on subscribing, exactly once', () => {
    const live = createPollingLiveUpdates();
    const seen: string[] = [];
    const stop = live.observe((mode) => seen.push(mode));

    expect(seen).toEqual(['polling']);
    expect(live.mode).toBe('polling');

    stop();
    expect(seen).toEqual(['polling']);
    live.close();
  });

  spec('a host that adopted no liveness says disabled rather than pretending', () => {
    const live = createManualLiveUpdates();
    const seen: string[] = [];
    live.observe((mode) => seen.push(mode));

    expect(live.mode).toBe('disabled');
    expect(seen).toEqual(['disabled']);

    const subscription = live.subscribe('conversation:a', () => undefined);
    subscription.notifyChanged();
    live.refresh();
    subscription.close();
    live.close();

    // Refusing to deliver is the whole contract here; a no-op that happened to
    // invoke its callback would be a live transport that is lying.
    expect(seen).toEqual(['disabled']);
  });
});

/**
 * A lane that discovers nothing exits zero and proves nothing.
 *
 * This is the guard for this package specifically: every behaviour above is
 * timing, and a filter or a rename that stopped collecting the file would leave
 * a green lane asserting nothing. It cannot prove the *file* ran — nothing inside
 * a file can — so it proves the suite did not quietly lose its cases.
 */
spec('the timing suite is still complete', () => {
  expect(registered.length).toBeGreaterThanOrEqual(11);
  expect(new Set(registered).size).toBe(registered.length);
});
