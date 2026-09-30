// packages/shared/utils/src/lib/common/stale_guard.ts
//
// Prevents a slow earlier request from overwriting the result of a newer one.
//
// This is the most common correctness bug in ViewModel-driven UIs: a user
// searches "a", then "ab"; if the "a" response arrives last it clobbers the
// "ab" result. `StaleGuard` makes the correct behaviour the default rather than
// something each screen has to remember.
//
// It does two things at once, which is why it is one object rather than two
// pieces of bookkeeping the caller has to keep in sync:
//   - a monotonically increasing token, checked with `isCurrent()`
//   - an `AbortSignal` per operation, so the superseded request is actually
//     cancelled instead of merely ignored

export type GuardedOperation = {
  /** Current only for the most recent `begin()`. */
  token: number;
  /** Aborted as soon as a newer operation begins, or on `cancelAll()`. */
  signal: AbortSignal;
};

export class StaleGuard {
  #generation = 0;
  #controller: AbortController | undefined;
  #cancelled = false;

  /** Start a new operation, superseding and aborting any previous one. */
  begin(): GuardedOperation {
    this.#controller?.abort();

    this.#generation += 1;
    this.#cancelled = false;

    const controller = new AbortController();
    this.#controller = controller;

    return { token: this.#generation, signal: controller.signal };
  }

  /** True while `token` is still the newest operation. */
  isCurrent(token: number): boolean {
    return !this.#cancelled && token === this.#generation;
  }

  /**
   * Abort the in-flight operation and invalidate every outstanding token.
   * Call from `dispose()` so a torn-down screen cannot be written to.
   */
  cancelAll(): void {
    this.#cancelled = true;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#generation += 1;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }
}
