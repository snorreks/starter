// apps/frontend/native/src/lib/viewmodels/app_lifecycle_view_model.test.ts
//
// The decision, not the wiring.
//
// What this asserts is the part that was previously in the root layout and could
// only be read: *when* the app refreshes, and what it renders while it cannot.
// The listeners themselves are covered in `app_lifecycle.test.ts` against a real
// `EventTarget`; this covers the rule that decides a refresh is safe, which is a
// rule about intent rather than about plumbing.

import { describe, expect, test } from 'bun:test';
import { createAppLifecycle, type LifecyclePhase } from '#lib/platform/app_lifecycle.ts';
import { createAppLifecycleViewModel } from './app_lifecycle_view_model.ts';

const harness = (initial: { hidden: boolean; online: boolean }) => {
  const state = { hidden: initial.hidden, online: initial.online, refreshes: 0 };
  const events = new EventTarget();
  const seen: LifecyclePhase[] = [];

  const viewModel = createAppLifecycleViewModel({
    events,
    isHidden: () => state.hidden,
    isOnline: () => state.online,
    refreshSession: () => {
      state.refreshes += 1;
    },
  });
  const unsubscribe = viewModel.subscribe((phase) => seen.push(phase));
  const stop = viewModel.start();

  const fire = (name: string): void => {
    if (name === 'visibilitychange' || name === 'pagehide') {
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
    state,
    seen,
    fire,
    phase: viewModel.phase,
    unreachable: viewModel.unreachable,
    dispose: (): void => {
      unsubscribe();
      stop();
    },
  };
};

describe('when the app refreshes', () => {
  test('a subscriber is told the current phase before anything happens', () => {
    const app = harness({ hidden: false, online: true });

    // Not a later transition: the initial value, so a subscriber that renders
    // once cannot miss an app that was restored already-suspended.
    expect(app.seen).toEqual(['active']);
    app.dispose();
  });

  test('coming back to the foreground refreshes exactly once', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('visibilitychange');
    expect(app.state.refreshes).toBe(0);

    app.fire('pageshow');
    expect(app.state.refreshes).toBe(1);

    // A second foreground event with no change is not a second refresh.
    app.fire('pageshow');
    expect(app.state.refreshes).toBe(1);
    app.dispose();
  });

  test('going into the background never refreshes', () => {
    // The process is about to be frozen, so the request would hang rather than
    // complete. A refresh here is a request that never finishes and a spinner
    // that never stops.
    const app = harness({ hidden: false, online: true });

    app.fire('visibilitychange');
    app.fire('pagehide');

    expect(app.state.refreshes).toBe(0);
    app.dispose();
  });

  test('regaining the network while still backgrounded does not refresh', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('visibilitychange');
    app.fire('offline');
    app.fire('online');
    expect(app.state.refreshes).toBe(0);

    // Only the return to the foreground is the moment it is safe.
    app.fire('pageshow');
    expect(app.state.refreshes).toBe(1);
    app.dispose();
  });
});

describe('what it renders', () => {
  test('an app restored while offline says so before any event fires', () => {
    const app = harness({ hidden: true, online: false });

    expect(app.phase()).toBe('offline');
    expect(app.unreachable()).toBe(true);
    app.dispose();
  });

  test('an app restored while backgrounded says so', () => {
    const app = harness({ hidden: true, online: true });

    expect(app.unreachable()).toBe(true);
    app.dispose();
  });

  test('it clears when the app is back and connected', () => {
    const app = harness({ hidden: false, online: true });

    app.fire('offline');
    expect(app.unreachable()).toBe(true);

    app.fire('online');
    expect(app.unreachable()).toBe(false);
    app.dispose();
  });
});

describe('with no window to observe', () => {
  test('prerendering reports active rather than unreachable', () => {
    // A prerendered page is served to a browser that has its own lifecycle.
    // Claiming "unreachable" at build time would put an offline banner over a
    // page nobody is looking at yet, and it would never clear itself.
    const viewModel = createAppLifecycleViewModel({
      events: null,
      refreshSession: () => {
        throw new Error('a prerendered page must not refresh');
      },
    });

    expect(viewModel.phase()).toBe('active');
    expect(viewModel.unreachable()).toBe(false);
    const unsubscribe = viewModel.subscribe(() => {});
    expect(() => viewModel.start()()).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('the lifecycle it wraps', () => {
  test('the ViewModel does not invent a second set of listeners', () => {
    // Two subscribers to one lifecycle: a wrapper that registered its own would
    // double every transition and every refresh.
    const events = new EventTarget();
    const state = { hidden: false, refreshes: 0 };
    const viewModel = createAppLifecycleViewModel({
      events,
      isHidden: () => state.hidden,
      isOnline: () => true,
      refreshSession: () => {
        state.refreshes += 1;
      },
    });
    viewModel.start();
    const direct = createAppLifecycle({ events, onChange: () => {} });

    state.hidden = true;
    events.dispatchEvent(new Event('visibilitychange'));
    state.hidden = false;
    events.dispatchEvent(new Event('pageshow'));

    expect(state.refreshes).toBe(1);
    expect(direct.phase()).toBe('active');
    viewModel.start()();
  });
});
