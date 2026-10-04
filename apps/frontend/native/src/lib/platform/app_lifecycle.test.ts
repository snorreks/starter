// apps/frontend/native/src/lib/platform/app_lifecycle.test.ts
//
// Suspend, resume and connectivity, driven through a real `EventTarget`.
//
// No phone is involved and none is needed for the part that actually breaks: the
// registration, the ordering and the "a change that is not a change" rule. What a
// phone adds is whether iOS and Android deliver these events at all, which is
// recorded as NOT RUN in docs/capability-matrix.md rather than asserted here.

import { describe, expect, test } from 'bun:test';
import {
  createAppLifecycle,
  type LifecycleEventName,
  type LifecyclePhase,
} from './app_lifecycle.ts';

const NAMES: readonly LifecycleEventName[] = [
  'visibilitychange',
  'online',
  'offline',
  'pagehide',
  'pageshow',
];

interface Harness {
  readonly events: EventTarget;
  readonly fire: (name: LifecycleEventName) => void;
  readonly seen: { phase: LifecyclePhase; previous: LifecyclePhase }[];
  readonly dispose: () => void;
  readonly phase: () => LifecyclePhase;
}

const harness = (initial: { hidden: boolean; online: boolean }): Harness => {
  const state = {
    hidden: initial.hidden,
    online: initial.online,
    seen: [] as { phase: LifecyclePhase; previous: LifecyclePhase }[],
  };
  const events = new EventTarget();

  const lifecycle = createAppLifecycle({
    events,
    isHidden: () => state.hidden,
    isOnline: () => state.online,
    onChange: (phase, previous) => {
      state.seen.push({ phase, previous });
    },
  });

  const fire = (name: LifecycleEventName): void => {
    if (name === 'visibilitychange') {
      state.hidden = true;
    }
    if (name === 'pagehide') {
      state.hidden = true;
    }
    if (name === 'pageshow') {
      state.hidden = false;
    }
    if (name === 'offline') {
      state.online = false;
    }
    if (name === 'online') {
      state.online = true;
    }
    events.dispatchEvent(new Event(name));
  };

  return {
    events,
    fire,
    get seen() {
      return state.seen;
    },
    dispose: lifecycle.dispose,
    phase: lifecycle.phase,
  };
};

describe('a running app', () => {
  test('starts active and stays active while nothing happens', () => {
    const app = harness({ hidden: false, online: true });

    expect(app.phase()).toBe('active');
    expect(app.seen).toEqual([]);
    app.dispose();
  });

  test('backgrounding reports suspension once, not once per event', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('visibilitychange');
    app.fire('pagehide');

    expect(app.phase()).toBe('suspended');
    // Two events fired and one transition happened: the second was not a change.
    expect(app.seen).toEqual([{ phase: 'suspended', previous: 'active' }]);
    app.dispose();
  });

  test('returning to the foreground reports active, which is the recovery moment', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('visibilitychange');
    app.fire('pageshow');

    expect(app.phase()).toBe('active');
    expect(app.seen.map((entry) => entry.phase)).toEqual(['suspended', 'active']);
    app.dispose();
  });

  test('losing the network outranks being visible, and regaining it does not re-report active twice', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('offline');
    expect(app.phase()).toBe('offline');

    // Still in the foreground, still offline: no transition, so no subscriber work.
    app.fire('visibilitychange');
    expect(app.phase()).toBe('offline');
    expect(app.seen.map((entry) => entry.phase)).toEqual(['offline']);

    app.fire('online');
    expect(app.phase()).toBe('suspended');
    app.fire('pageshow');
    expect(app.phase()).toBe('active');
    expect(app.seen.map((entry) => entry.phase)).toEqual(['offline', 'suspended', 'active']);
    app.dispose();
  });

  test('an app opened in the background does not report itself active first', () => {
    // iOS relaunches into the foreground, but a restored webview can be
    // restored hidden. Starting from `active` and correcting on the next event
    // means the first refresh runs against a frozen process.
    const app = harness({ hidden: true, online: true });
    expect(app.phase()).toBe('suspended');
    app.dispose();
  });
});

describe('disposal', () => {
  test('a disposed lifecycle stops reporting, so a torn-down screen is not resumed', () => {
    // The failure this prevents: a layout unmounts, the listener survives, and
    // the app refreshes a session for a view nobody is looking at — forever,
    // once per resume.
    const app = harness({ hidden: false, online: true });

    app.dispose();
    app.fire('visibilitychange');

    expect(app.seen).toEqual([]);
    app.dispose();
  });

  test('disposing twice is not an error', () => {
    const app = harness({ hidden: false, online: true });
    app.dispose();
    expect(() => app.dispose()).not.toThrow();
  });
});

describe('connectivity is read as a hint, not as an answer', () => {
  test('only `false` counts as offline', () => {
    // `navigator.onLine` is true on a phone attached to a Wi-Fi network with no
    // route. Reading it as an answer produces a "connected" UI that cannot
    // reach anything; reading `false` is the only actionable value.
    const events = new EventTarget();

    const phases: LifecyclePhase[] = [];
    const lifecycle = createAppLifecycle({
      events,
      isHidden: () => false,
      isOnline: () => true,
      onChange: (phase) => phases.push(phase),
    });

    expect(lifecycle.phase()).toBe('active');
    for (const name of NAMES) {
      events.dispatchEvent(new Event(name));
    }
    expect(lifecycle.phase()).toBe('active');
    expect(phases).toEqual([]);
    lifecycle.dispose();
  });
});
