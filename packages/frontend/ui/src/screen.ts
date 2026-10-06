// packages/frontend/ui/src/screen.ts
//
// Screen lifecycle primitives are composed into feature view models. The container
// owns a structural lifecycle contract; screens keep domain state and operation policy.

import type { MutationGuard, StaleGuard } from '@starter/utils';
import { MutationGuard as MutationGuardImpl, StaleGuard as StaleGuardImpl } from '@starter/utils';

/** Owns the abortable work and cleanup callbacks for one single-use screen. */
export class ScreenScope {
  readonly requests = new StaleGuardImpl();
  readonly mutations = new MutationGuardImpl();
  #closed = false;
  #cleanups = new Set<() => void>();

  get closed(): boolean {
    return this.#closed;
  }

  /** Register a release action; resources acquired after closure are released immediately. */
  onClose(cleanup: () => void): () => void {
    if (this.#closed) {
      cleanup();
      return () => {};
    }
    this.#cleanups.add(cleanup);
    return () => this.#cleanups.delete(cleanup);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.requests.cancelAll();
    this.mutations.dispose();
    for (const cleanup of this.#cleanups) {
      cleanup();
    }
    this.#cleanups.clear();
  }
}

/**
 * The minimum a container needs in order to own an object's lifecycle.
 *
 * Structural on purpose: nothing has to extend this, and nothing has to import a
 * base class to be mountable. A feature that needs no interactive state at all —
 * a button, a field — can skip this entirely, which is the point.
 */
export interface ScreenOwner {
  /** Reported in `data-testid` and in a lifecycle failure message. */
  readonly className: string;
  /**
   * True while a container owns this object.
   *
   * Public and writable only because the container has to claim and release it.
   * A ViewModel may read it — "am I still mounted?" — but must never write it.
   */
  mounted: boolean;
  /** Runs once per mount, on the client, after the container has claimed it. */
  initialize(): Promise<void>;
  /** Runs once on unmount, including while `initialize()` is pending. */
  dispose(): Promise<void>;
}

/** The two guards every stateful screen needs. */
export interface ScreenGuards {
  readonly requests: StaleGuard;
  readonly mutations: MutationGuard;
}

/**
 * Tear a screen down synchronously.
 *
 * Scopes cancel reads and writes together before the owner releases resources.
 *
 * A function rather than a protected method on a base class: it takes the guards
 * as arguments, so a ViewModel composes it instead of inheriting the ability to
 * call it, and a caller cannot reach it by accident from outside.
 *
 * Synchronous and deliberately not awaited. Every part of it is synchronous
 * abort/dispose work; making it a promise would invite a caller to forget to await
 * a teardown that has already happened.
 */
export const disposeScreen = (guards: ScreenGuards, after?: () => void | Promise<void>): void => {
  if ('scope' in guards && guards.scope instanceof ScreenScope) {
    guards.scope.close();
  } else {
    guards.requests.cancelAll();
    guards.mutations.dispose();
  }
  void after?.();
};

/**
 * Run a write, refusing it if the screen has already been torn down.
 *
 * Returns `true` when the write started. `false` means the screen is gone, which
 * is not an error: the caller is showing something nobody is looking at any more.
 *
 * The three bugs this replaces are described at `MutationGuard` in
 * `@starter/utils`. The reason it is a helper and not just a `try/finally` at each
 * call site is that the accounting is easy to get subtly wrong — a `finally` that
 * clears a flag when the *first* of two in-flight writes finishes is the exact bug
 * the counter exists to prevent.
 */
export const runScreenWrite = async (
  guards: ScreenGuards,
  write: (handle: NonNullable<ReturnType<MutationGuard['begin']>>) => Promise<unknown>,
): Promise<boolean> => {
  const handle = guards.mutations.begin();
  if (handle === null) {
    return false;
  }
  try {
    await write(handle);
    return true;
  } finally {
    guards.mutations.end();
  }
};
