// apps/frontend/native/src/lib/viewmodels/app_lifecycle_view_model.ts
//
// What the app does when the OS takes the window away.
//
// The View owns the listeners and the markup; this owns the *decision*. That
// split is the View -> ViewModel -> Services rule applied to a platform concern
// rather than to a screen, and it is not ceremony: the decision here is "is a
// refresh safe right now", and answering it inside the layout meant the layout
// knew when to call a service and what the answer meant.
//
// Two rules, and the second is the reason this is a ViewModel at all:
//
//   * **Coming back to `active` is the only moment a refresh is automatic.** The
//     session may have been revoked on another device and the list on screen may
//     be hours old. Going *out* is not a moment to refresh: the process is about
//     to be frozen, so the request would hang rather than complete.
//   * **Nothing retries.** A retry of a request that may already have been
//     received duplicates it, and a phone that regains connectivity in a lift
//     would otherwise hammer a server it cannot reach. Recovery is a tap.
//
// The service is injected rather than imported. `#lib/composition/session.ts` is
// the composition root and owns the decision about *which* session service this
// host has; a ViewModel that imported it would be a second, module-scope copy of
// that decision, and the guard's `no module-level request state` rule exists for
// exactly this.

import {
  createAppLifecycle,
  type LifecycleEvents,
  type LifecyclePhase,
} from '#lib/platform/app_lifecycle.ts';

export interface AppLifecycleViewModelOptions {
  /**
   * The session refresh. Called on the transition *into* `active` and nowhere
   * else. A rejection is the caller's business: this does not retry and does not
   * swallow.
   */
  readonly refreshSession: () => void;
  /** What to listen on. `null` during prerendering, where there is no window. */
  readonly events: LifecycleEvents | null;
  /**
   * The platform's own visibility and connectivity answers.
   *
   * Optional, and defaulting to `document.visibilityState` and `navigator.onLine`
   * — which is what a real shell wants. They are parameters because the whole
   * decision above is untestable through them: a test cannot put a phone into
   * the background, and a chain that reads a global at construction cannot be
   * driven at all without a mock of `document`.
   */
  readonly isHidden?: () => boolean;
  readonly isOnline?: () => boolean;
}

export interface AppLifecycleViewModel {
  readonly phase: () => LifecyclePhase;
  /** What the View renders: true while suspended or offline. */
  readonly unreachable: () => boolean;
  /** Notified on every phase change. Returns the function that unsubscribes. */
  readonly subscribe: (listener: (phase: LifecyclePhase) => void) => () => void;
  /**
   * Attach the listeners; returns the function that removes them.
   *
   * `createAppLifecycle` attaches at construction, so this is the symmetric half
   * rather than a second attachment. It exists so the View has one call and one
   * cleanup, and so a lifecycle that is created lazily can be added without
   * changing the View.
   */
  readonly start: () => () => void;
}

export const createAppLifecycleViewModel = (
  options: AppLifecycleViewModelOptions,
): AppLifecycleViewModel => {
  const { events, refreshSession } = options;
  const noop = (): (() => void) => (): void => {};

  // Without events there is nothing to observe, so the answer is a permanent
  // "active": a prerendered page is served to a browser that has its own
  // lifecycle, and reporting it as unreachable would show an offline banner over
  // a page nobody is looking at yet.
  if (events === null) {
    return {
      phase: () => 'active',
      unreachable: () => false,
      subscribe: () => noop(),
      start: noop,
    };
  }

  const listeners = new Set<(phase: LifecyclePhase) => void>();
  let unreachable = false;

  const lifecycle = createAppLifecycle({
    events,
    ...(options.isHidden === undefined ? {} : { isHidden: options.isHidden }),
    ...(options.isOnline === undefined ? {} : { isOnline: options.isOnline }),
    onChange: (phase: LifecyclePhase) => {
      unreachable = phase !== 'active';
      for (const listener of listeners) {
        listener(phase);
      }
      if (phase === 'active') {
        refreshSession();
      }
    },
  });

  // Read from the lifecycle rather than assumed. An app whose process was frozen
  // and whose webview is restored *hidden* would otherwise render as connected
  // until its first transition — which may be minutes away, or never.
  unreachable = lifecycle.phase() !== 'active';

  return {
    phase: lifecycle.phase,
    unreachable: () => unreachable,
    subscribe: (listener) => {
      listeners.add(listener);
      // The current value, so a subscriber that renders once from `unreachable`
      // does not need a second call and cannot miss the initial state.
      listener(lifecycle.phase());
      return (): void => {
        listeners.delete(listener);
      };
    },
    start: (): (() => void) => lifecycle.dispose,
  };
};
