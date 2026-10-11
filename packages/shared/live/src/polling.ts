// packages/shared/live/src/polling.ts
//
// The polling implementation: the always-correct baseline.
//
// **Why this exists rather than being a fallback inside the socket transport.** A
// transport that degrades internally hides its degradation behind a constructor
// flag, and the two states have different owners — one is this deployment's
// configuration, the other is a network that is having a bad day. Exposing them
// as two implementations of one interface means the host chooses, the screen sees
// which it got, and the socket transport's failure path is a substitution rather
// than a branch inside a class that is already large.
//
// **The four properties this file is responsible for**, each one a specific
// failure it prevents:
//
//   1. **It stops.** No subscribers means no timer at all. The way to be sure a
//      poll stopped is to hold no handle to cancel.
//   2. **It backs off, and collapses.** An interval that produced no change grows
//      by `backoff` toward `maxMs`; one that did resets to `baseMs`. A chat
//      screen that is not being written to costs a bounded number of requests, and
//      one that is being written to is still re-read at the floor.
//   3. **A removed subscriber is never called.** Unsubscribing inside a callback
//      is the normal way a screen tears itself down, so the in-flight iteration is
//      settled before the removal takes effect for the *next* one.
//   4. **Nothing fires after `close`.** A timer that outlives its owner is how a
//      disposed screen writes into state nobody is rendering.

import {
  LIVE_POLL_BACKOFF,
  LIVE_POLL_BASE_MS,
  LIVE_POLL_MAX_MS,
  type LiveMode,
  type LiveScheduler,
  type LiveUpdates,
} from './contract.ts';

export interface PollingLiveUpdatesOptions {
  /** Injected so a test controls the delays. Defaults to the platform's own. */
  readonly scheduler?: LiveScheduler;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly backoff?: number;
  /**
   * Whether anyone is looking. A host fact, injected.
   *
   * Consulted only when a delay is scheduled, never per topic: a tab that went
   * hidden between two callbacks should lose the timer at the next boundary, not
   * have every subscription asked individually. Resuming is `refresh()`, which the
   * host calls from `visibilitychange` — a window that was hidden missed every
   * notification it would have been sent, so its held snapshot is behind by an
   * unbounded amount and no steady-state behaviour catches up.
   */
  readonly isActive?: () => boolean;
}

const platformScheduler: LiveScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

interface Entry {
  readonly notify: () => void;
}

/**
 * A transport that re-reads on a bounded interval and backs off when idle.
 *
 * Reports `mode: 'polling'` permanently: it has no push path to lose, so calling
 * it a degraded state would be false. A host with no live updates at all uses
 * `createManualLiveUpdates`, which is a different thing with a different owner.
 */
export const createPollingLiveUpdates = (options: PollingLiveUpdatesOptions = {}): LiveUpdates => {
  const scheduler = options.scheduler ?? platformScheduler;
  const baseMs = options.baseMs ?? LIVE_POLL_BASE_MS;
  const maxMs = options.maxMs ?? LIVE_POLL_MAX_MS;
  const backoff = options.backoff ?? LIVE_POLL_BACKOFF;
  const isActive = options.isActive ?? (() => true);

  const entries = new Set<Entry>();
  // A const, not `$state`: this transport's mode cannot change, and pretending
  // otherwise would mean carrying a listener set that is only ever written to.
  // `observe` therefore fires once and the transport says so by having no second
  // value to report.
  const mode: LiveMode = 'polling';

  let handle: number | null = null;
  let delay = baseMs;
  let closed = false;

  const clearTimer = (): void => {
    if (handle !== null) {
      scheduler.clearTimeout(handle);
      handle = null;
    }
  };

  const schedule = (): void => {
    clearTimer();
    if (closed || entries.size === 0 || !isActive()) {
      return;
    }
    handle = scheduler.setTimeout(() => {
      handle = null;
      if (closed) {
        return;
      }
      delay = Math.min(maxMs, delay * backoff);
      // Snapshot first: a listener that unsubscribes itself — which every screen
      // does when it tears down — must not shorten this iteration, and must never
      // be called again by a later one.
      for (const entry of [...entries]) {
        if (closed) {
          return;
        }
        entry.notify();
      }
      schedule();
    }, delay);
  };

  return {
    get mode() {
      return mode;
    },
    observe(listener) {
      if (closed) {
        return () => undefined;
      }
      listener(mode);
      return () => undefined;
    },
    subscribe(_topic, onInvalidated) {
      if (closed) {
        return { notifyChanged: () => undefined, close: () => undefined };
      }
      const entry: Entry = { notify: onInvalidated };
      entries.add(entry);
      schedule();
      let open = true;
      return {
        notifyChanged() {
          if (!open || closed) {
            return;
          }
          // Collapse and re-arm, rather than setting a flag for the next tick to
          // read. The re-arm is what makes the collapse take effect immediately:
          // a screen that reports a change twenty seconds after a tick has already
          // chosen its next delay would otherwise wait out that full interval
          // before becoming responsive again, which is the exact moment liveness
          // matters most.
          delay = baseMs;
          schedule();
        },
        close() {
          if (!open) {
            return;
          }
          open = false;
          entries.delete(entry);
          // The last subscriber leaving is what stops the loop. Holding the timer
          // until some future `close()` would be a screen that never stops asking.
          if (entries.size === 0) {
            clearTimer();
          }
        },
      };
    },
    refresh() {
      if (closed || entries.size === 0) {
        return;
      }
      delay = baseMs;
      for (const entry of [...entries]) {
        entry.notify();
      }
      schedule();
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearTimer();
      entries.clear();
    },
  };
};

/**
 * A transport that never delivers anything.
 *
 * Exists so a screen can be written once against `LiveUpdates` and every host can
 * satisfy it, rather than every call site carrying `LiveUpdates | null`. A host
 * that has decided not to adopt live updates passes this; a host that has adopted
 * them and whose socket is down passes a polling one, and those are different
 * answers that a screen reports differently.
 */
export const createManualLiveUpdates = (): LiveUpdates => {
  const noop = (): void => undefined;
  return {
    mode: 'disabled',
    observe(listener) {
      listener('disabled');
      return noop;
    },
    subscribe: () => ({ notifyChanged: noop, close: noop }),
    refresh: noop,
    close: noop,
  };
};
