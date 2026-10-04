// apps/frontend/native/src/lib/platform/app_lifecycle.ts
//
// What the app does when the OS takes the window away, and how it comes back.
//
// Mobile is the first platform here where "the page is still there" stops being
// true in a way the user can act on. On a desktop the window either exists or the
// process is gone. On a phone the app is suspended: timers stop, in-flight
// fetches are frozen rather than cancelled, and the webview is handed back
// minutes or hours later with every answer it was waiting for long since
// irrelevant. It also loses the network without an error, and the very next
// request fails in a way that is indistinguishable from "the server is down".
//
// Three facts, and they are the whole module:
//
//   * `visibilitychange` to `hidden` is the suspension signal. iOS and Android
//     both stop timers and pause the webview behind it, and both deliver it
//     before the process is frozen.
//   * `offline`/`online` are the connectivity signals. `navigator.onLine` is
//     famously optimistic — it reports "online" on a captive portal — so it is
//     never consulted as an answer, only as a hint that something changed.
//   * Nothing here retries. It cancels, and it tells its subscriber. Recovery is
//     the subscriber's decision, because only the subscriber knows what is worth
//     re-fetching and what must not be re-fetched (a POST that creates something).
//
// The platform events are injected rather than read from `window`, so this is
// testable on a machine with no phone attached — and a test that drives a real
// `EventTarget` proves the listener registration and the ordering, which is the
// part that is easy to get wrong and impossible to see failing.

export type LifecyclePhase = 'active' | 'suspended' | 'offline';

/** The events a mobile shell actually delivers. */
export type LifecycleEventName =
  | 'visibilitychange'
  | 'online'
  | 'offline'
  | 'pagehide'
  | 'pageshow';

/**
 * What to listen on.
 *
 * `EventTarget`, not five separate `EventTarget`s. A real `window` satisfies it
 * with no adapter and a test's `EventTarget` satisfies it with no mock of `window`
 * at all — the object under test is then the same *type* it gets in the shell. A
 * `Record<name, EventTarget>` would have demanded a hand-built object from every
 * caller, which is how a `window` cast into the code appears.
 */
export type LifecycleEvents = EventTarget;

export interface AppLifecycleOptions {
  /**
   * Events to listen on. A real `window` satisfies this; a test supplies an
   * `EventTarget` and drives it.
   */
  readonly events: LifecycleEvents;
  /** Called once per transition. Not called for a transition that did not change the phase. */
  readonly onChange: (phase: LifecyclePhase, previous: LifecyclePhase) => void;
  /** Read for the initial phase, so a suspended-at-startup app is not reported active. */
  readonly isHidden?: () => boolean;
  /** Read for the initial phase and on every transition. */
  readonly isOnline?: () => boolean;
}

export interface AppLifecycle {
  readonly phase: () => LifecyclePhase;
  /** Remove every listener. Called from the component that installed it. */
  readonly dispose: () => void;
}

/**
 * The default visibility question.
 *
 * `document` rather than the injected event: the injected *events* are the things
 * to listen on, and a listener registration is the part that breaks silently.
 * The state itself is a one-line read of a global that exists wherever the events
 * do, and the default is only used when a caller has not supplied a probe.
 */
const defaultIsHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Connectivity, as a hint and nothing more.
 *
 * `navigator.onLine` reports `true` on a captive portal and on a phone whose
 * Wi-Fi is associated but has no route. It is read here only to decide that
 * something changed, and a subscriber that trusts it as an answer will show a
 * connected UI for a network that cannot reach anything. `false` is the only
 * value acted on.
 */
const defaultIsOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

export const createAppLifecycle = (options: AppLifecycleOptions): AppLifecycle => {
  const isHidden = options.isHidden ?? defaultIsHidden;
  const isOnline = options.isOnline ?? defaultIsOnline;

  const current = (): LifecyclePhase => {
    if (!isOnline()) {
      return 'offline';
    }
    return isHidden() ? 'suspended' : 'active';
  };

  // Declared before it is read: an app that is resumed in the background has to
  // start from `suspended`, not from `active` and then correct itself.
  let phase: LifecyclePhase = current();
  let disposed = false;

  const transition = (next: LifecyclePhase): void => {
    if (disposed || next === phase) {
      return;
    }
    const previous = phase;
    phase = next;
    options.onChange(phase, previous);
  };

  const evaluate = (): void => {
    transition(current());
  };

  const listeners: readonly [LifecycleEventName, () => void][] = [
    ['visibilitychange', evaluate],
    ['online', evaluate],
    ['offline', evaluate],
    // iOS delivers `pagehide` when the app is swapped out of memory and
    // `pageshow` when it is restored. Without them a restore from a swap looks
    // exactly like a page that never went away, and the app keeps showing state
    // from before it was gone.
    ['pagehide', evaluate],
    ['pageshow', evaluate],
  ];

  for (const [event, handler] of listeners) {
    options.events.addEventListener(event, handler);
  }

  return {
    phase: () => phase,
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [event, handler] of listeners) {
        options.events.removeEventListener(event, handler);
      }
    },
  };
};

/**
 * The real `window`, or nothing.
 *
 * `undefined` during prerendering, where there is no window and no lifecycle to
 * observe — and returning nothing is correct there rather than a silent failure,
 * because a prerendered page is served to a browser that has its own.
 */
export const browserLifecycleEvents = (): LifecycleEvents | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window;
};
