// packages/shared/live/src/contract.ts
//
// The liveness contract: how a screen learns that what it is showing may be stale.
//
// **What travels over this interface, and what deliberately does not.** A
// notification carries no content. It says "topic X may have moved since you last
// looked" and nothing else, and the screen answers by re-reading its own
// authoritative snapshot through the service it already has.
//
// That is a smaller contract than a message bus, and it is smaller on purpose:
//
//   - The transport never becomes a second source of truth. A row that arrived over
//     a socket would be a row this application did not read through its own
//     authorization check, and the moment it exists the interesting question is
//     which of the two copies a screen renders.
//   - There is nothing to authorize per message, so a subscription is authorized
//     once, at attach time, against the same owner check the REST read performs.
//   - A dropped or duplicated notification is harmless, because the notification
//     was only ever a hint to re-read. A dropped *message* would have to be
//     recovered, and recovery is where realtime systems grow state they cannot
//     evict.
//
// **Why a screen subscribes to a topic rather than being handed a socket.** The
// screen already knows how to reconcile a snapshot — `ChatViewModel` has had a
// merge function for the whole of its life, and it is the same function the SSR
// `$effect` calls. Reusing it means a notification and a navigation converge on
// one code path, so "arrived by push" and "arrived by refresh" cannot drift.
//
// **Why the mode is part of the contract.** A screen on a broken socket that
// silently degrades to periodic reads is a screen making a claim it cannot back
// up: the user sees a transcript and reasonably believes it is current. `mode`
// is what lets the host say so out loud, and it is why the polling fallback is
// a *declared* state rather than an invisible behaviour.

/**
 * How liveness is currently being delivered.
 *
 * `disabled` is a deliberate deployment choice, distinct from `polling`: one is
 * "this deployment does not offer push", the other is "push is unavailable right
 * now". Both render as eventually-consistent, but only one of them is anybody's
 * decision, and conflating them hides a broken socket behind a feature flag.
 */
export type LiveMode =
  /** No push transport is configured. Reads are periodic. */
  | 'disabled'
  /** A push transport exists and is opening. Reads are periodic until it does. */
  | 'connecting'
  /** Push is delivering. Notifications are the primary path. */
  | 'live'
  /** Push is down or was refused. Reads are periodic, and this is a degradation. */
  | 'polling';

/** One live registration. Closing it twice is a no-op rather than an error. */
export interface LiveSubscription {
  /**
   * Report that the last invalidation found a real change.
   *
   * This exists so a polling transport can collapse its backoff. Without it a
   * transport has to guess whether a screen that keeps re-reading is busy or
   * idle, and backing off during an active conversation while staying fast during
   * an abandoned one is exactly backwards.
   *
   * Calling it without a preceding invalidation is meaningless and is ignored.
   */
  notifyChanged(): void;
  close(): void;
}

/**
 * A source of "this may be stale" notifications for the screens that asked.
 *
 * Implementations are per-host and are constructed at a composition root, never
 * found by a screen: the web application supplies a socket transport, the native
 * shell may supply the same or none, and a test supplies a fake. A screen takes
 * this as a constructor dependency for the same reason it takes a transport or a
 * `Navigation` — a feature that reached for the ambient one could only ever run
 * in one host.
 */
export interface LiveUpdates {
  /** The mode as of right now. Read it; do not cache it. */
  readonly mode: LiveMode;
  /**
   * Observe mode changes. Fires once with the current mode, then on every change.
   *
   * Returns an unsubscribe. The initial call is deliberate: a screen that
   * subscribed and never heard anything would be indistinguishable from one whose
   * transport is healthy, which is the state nobody wants to debug.
   */
  observe(listener: (mode: LiveMode) => void): () => void;
  /**
   * Register interest in a topic.
   *
   * A topic is an opaque string the *host* composes — `conversation:<id>` is one
   * application's choice and this package never parses one. Callers unsubscribe by
   * closing the returned handle, and unsubscribing during a callback is safe: the
   * in-flight delivery is finished first, so a listener removed mid-notification
   * is never called again.
   *
   * The callback carries nothing, on purpose. See the note at the top of this file.
   */
  subscribe(topic: string, onInvalidated: () => void): LiveSubscription;
  /**
   * Invalidate every subscription now and restart the backoff.
   *
   * This is what a host calls on window focus and on `visibilitychange` into
   * `visible`. A tab that was hidden missed every notification it would have
   * received, so its held snapshot is behind by an unbounded amount and no amount
   * of steady-state behaviour catches up.
   */
  refresh(): void;
  /** Release every subscription and timer. Idempotent. */
  close(): void;
}

/**
 * The polling bounds every implementation starts from, in milliseconds.
 *
 * `BASE` is the first wait and the floor between two reads. `MAX` is the ceiling
 * the backoff climbs to, so a screen nobody is looking at costs a bounded number
 * of requests rather than an unbounded number spread over the rest of the day.
 */
export const LIVE_POLL_BASE_MS = 1_500;
export const LIVE_POLL_MAX_MS = 20_000;

/** Multiplier applied once per interval that produced no change. */
export const LIVE_POLL_BACKOFF = 1.5;

/**
 * The timer seam.
 *
 * `setTimeout` is an interface rather than a global call because the thing worth
 * proving about a poll is that *it stops*, and a poll that reached for the global
 * could only be tested by waiting in real time — which is a slow test that passes
 * when it should fail.
 */
export interface LiveScheduler {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}
