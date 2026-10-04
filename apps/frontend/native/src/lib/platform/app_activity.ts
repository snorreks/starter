// apps/frontend/native/src/lib/platform/app_activity.ts
//
// Whether this window is in front of the user, as one observable answer.
//
// Why a host module at all
// -----------------------
// The shared `JobsViewModel` is told when to stop polling; it never asks. That
// split is deliberate — "is a window visible" is a fact about the shell, and a
// shared feature that read it would either import a Tauri API (refused by the
// guard) or reach for `document` and be wrong on a phone, where a backgrounded
// app is not merely hidden but suspended and its timers stopped by the OS.
//
// So the web route reads `document.visibilityState` directly and this module gives
// the native shell the equivalent, from both signals a shell actually gets:
//
//   * `visibilitychange` on the webview document — a hidden or minimised window,
//     and on mobile a backgrounded app;
//   * `focus` / `blur` on the window — a window that lost focus behind another one,
//     which Tauri reports without necessarily changing visibility.
//
// Both are normalised into one boolean, and a caller cannot receive two disagreeing
// answers because the state is recomputed on every event rather than tracked as two
// separate flags.
//
// A structural target rather than `Document` and `Window` types, so the rule is
// testable in the package's Bun lane with no webview, and so this file cannot
// accidentally become a place that reads a Tauri binding.

export interface ActivityTarget {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The one signal a shell reports: is the user looking at this right now? */
export type ActiveListener = (active: boolean) => void;

/** True when the window is visible *and* focused. */
export const isActive = (target: ActivityTarget, focused: boolean): boolean =>
  target.visibilityState === 'visible' && focused;

/**
 * Report activity changes to `listener`, starting with the current state.
 *
 * The immediate call is what makes this safe to wire from an effect: the screen
 * starts from the right answer instead of assuming "visible" and being wrong in a
 * window that is already behind another one.
 *
 * Returns the unsubscribe. An effect cleanup cannot await, so this is synchronous
 * on purpose, and it detaches all three listeners rather than leaking them across
 * navigations.
 */
export const watchAppActivity = (
  listener: ActiveListener,
  target: ActivityTarget = globalThis.document as ActivityTarget,
): (() => void) => {
  let focused = true;

  const publish = (): void => {
    listener(isActive(target, focused));
  };

  const onVisibility = (): void => publish();
  const onFocus = (): void => {
    focused = true;
    publish();
  };
  const onBlur = (): void => {
    focused = false;
    publish();
  };

  target.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('focus', onFocus);
  target.addEventListener('blur', onBlur);
  publish();

  return () => {
    target.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('focus', onFocus);
    target.removeEventListener('blur', onBlur);
  };
};
