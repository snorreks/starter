// packages/frontend/services/src/base/base_view_model.svelte.ts
//
// The ViewModel base.
//
// A ViewModel owns *screen state*: what is loading, what the error is, what the
// user can do right now. It does not own transport (that is a service) and it
// does not own business rules (those are pure functions or server use cases).
//
// Everything reactive here is declared with `$state` / `$derived` inside a
// `.svelte.ts` file. That is the whole reason for the suffix: these classes are
// only deeply reactive because the Svelte compiler processes this file.

import { MutationGuard, StaleGuard } from '@starter/utils';
import {
  BaseFrontendClass,
  type BaseFrontendClassInterface,
  type BaseFrontendClassOptions,
} from './base_frontend_class.ts';

export type BaseViewModelOptions = BaseFrontendClassOptions & {
  /** Show the full-screen loading state from the first paint. */
  startWithLoadingView?: boolean;
};

export type BaseViewModelInterface = BaseFrontendClassInterface & {
  /**
   * Read by `BaseViewModelContainer` to enforce a single owner. A ViewModel
   * retained by a parent across tab switches must not be initialized twice.
   */
  __mounted: boolean;

  readonly errorMessage: string | undefined;
  /** Replaces the view with the app loading state. */
  readonly showLoadingView: boolean;

  /**
   * Runs once per mount, on the client, after the ViewModel is owned.
   * Anything that must exist on the server too belongs in the constructor.
   */
  initialize(): Promise<void>;
};

export abstract class BaseViewModel<Options extends BaseViewModelOptions = BaseViewModelOptions>
  extends BaseFrontendClass<Options>
  implements BaseViewModelInterface
{
  __mounted = false;

  errorMessage = $state<string | undefined>(undefined);
  protected _showLoadingView = $state(false);

  /**
   * Supersedes and aborts the previous async operation on every `begin()`.
   *
   * This is what stops a slow earlier request from overwriting a newer result.
   * A screen that does not use it must justify why it cannot race.
   *
   * It guards *loads*. Writes go through `_mutations`, because a write needs a
   * different answer: "you may not start this" rather than "ignore your result".
   */
  protected readonly _requests = new StaleGuard();

  /**
   * Tracks in-flight writes and whether this ViewModel has been released.
   *
   * Two things it fixes that a boolean cannot:
   *
   *   * A write that completes after `dispose()` used to assign into a released
   *     ViewModel. `begin()` returns null once disposed, so the command refuses
   *     instead of starting.
   *   * `isMutating` used to be cleared by the first of several overlapping
   *     mutations. It is now derived from a count.
   *
   * A screen's optimistic rollback belongs here too — see `_optimistic` in
   * `NotesViewModel` — so that the two halves of a write are disposed together.
   */
  protected readonly _mutations = new MutationGuard();

  /** Cleanups from `$effect.root`, run on dispose. */
  #effectCleanups: Array<() => void> = [];

  get showLoadingView(): boolean {
    return this._showLoadingView;
  }

  constructor(options: Options) {
    super(options);
    if (options.startWithLoadingView) {
      this._showLoadingView = true;
    }
  }

  async initialize(): Promise<void> {
    await Promise.resolve();
  }

  /**
   * Register a reactive root owned by this ViewModel.
   *
   * Prefer this over a bare `$effect` in a command: an effect created outside a
   * root during teardown is never cleaned up, and the leak is invisible until
   * the screen is visited enough times to matter.
   */
  protected registerEffectRoot(fn: () => void): void {
    this.#effectCleanups.push($effect.root(fn));
  }

  /** True once `dispose()` has run. Commands must not start work after this. */
  protected get _disposed(): boolean {
    return this._mutations.disposed;
  }

  /** True while at least one write is in flight. Derived, so it cannot lie. */
  get isMutating(): boolean {
    return this._mutations.busy;
  }

  /**
   * Run a write with lifecycle accounting.
   *
   * Refuses when the ViewModel is disposed, and always ends the mutation — so
   * `isMutating` cannot be left stuck on by a path that throws before reaching
   * its own `finally`.
   */
  protected async _runMutation(
    write: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<boolean> {
    const handle = this._mutations.begin();

    if (handle === null) {
      this.debug('refusing a mutation: this ViewModel has been disposed');
      return false;
    }

    try {
      await write(handle.signal);
      return true;
    } catch (error) {
      this.showErrorNotification(error);
      return false;
    } finally {
      this._mutations.end();
    }
  }

  override async dispose(): Promise<void> {
    this.__mounted = false;

    // Order matters. Loads are aborted first so a response cannot write into a
    // ViewModel that is being released, then writes are refused and aborted for
    // the same reason, then effect roots are torn down.
    this._requests.cancelAll();
    this._mutations.dispose();

    for (const cleanup of this.#effectCleanups) {
      cleanup();
    }
    this.#effectCleanups = [];

    await super.dispose();
  }
}
