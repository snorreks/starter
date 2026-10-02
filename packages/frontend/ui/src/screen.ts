// packages/frontend/ui/src/screen.ts
//
// Screen lifecycle, by composition.
//
// What this replaces, and why
// --------------------------
// This was a three-deep inheritance chain — `BaseFrontendClass` → `BaseViewModel`
// → `BaseFormViewModel` — in a package called `@starter/frontend-services` that
// had exactly three subclasses in the whole repository, two of which overrode the
// method they inherited and never called `super`.
//
// The audit of that chain found thirteen members with no caller anywhere:
// `openConfirmDialog`, `requestSignIn`, `runCommand`, `registerEffectRoot`,
// `isValid`, `handleChange`, `getInitialValues`, `onSubmit`, `setLogLevel`,
// `info`, `log`, `spam`, and both observer factories. `BaseFormViewModel`'s
// validation and error mapping were unreachable in practice, because
// `AuthViewModel.handleSubmit` overrode it without calling up.
//
// What survives is the part that was actually load-bearing, and it already lived
// somewhere better: `StaleGuard`, `MutationGuard` and `OptimisticUpdate` are in
// `@starter/utils`, are framework-free, and are the three rules that fix real
// bugs — a superseded load cannot write, a write cannot outlive its owner, and a
// failed optimistic change yields to a newer one. A ViewModel now *holds* those
// objects instead of inheriting a way to reach them.
//
// What is left here is only what a container genuinely needs from whatever it
// mounts, stated as a structural shape rather than a class. A ViewModel satisfies
// it by holding two guards and implementing two methods.

import type { MutationGuard, StaleGuard } from '@starter/utils';

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
  /** Runs once per mount, after `initialize()` has settled. */
  dispose(): Promise<void>;
}

/** The two guards every stateful screen needs. */
export interface ScreenGuards {
  readonly requests: StaleGuard;
  readonly mutations: MutationGuard;
}

/**
 * Tear a screen down, in the only order that is safe.
 *
 * Loads first, then writes, then anything else. Reversed, a mutation that
 * completes between the two lines would assign state onto an object whose
 * requests were still live, and a `finally` in that mutation would clear a counter
 * the next one had already incremented.
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
  guards.requests.cancelAll();
  guards.mutations.dispose();
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
