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

import {
  BaseFrontendClass,
  type BaseFrontendClassInterface,
  type BaseFrontendClassOptions,
} from './base_frontend_class.ts';
import { StaleGuard } from '@starter/utils';

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

export abstract class BaseViewModel<
  Options extends BaseViewModelOptions = BaseViewModelOptions,
> extends BaseFrontendClass<Options> implements BaseViewModelInterface {
  __mounted = false;

  errorMessage = $state<string | undefined>(undefined);
  protected _showLoadingView = $state(false);

  /**
   * Supersedes and aborts the previous async operation on every `begin()`.
   *
   * This is what stops a slow earlier request from overwriting a newer result.
   * A screen that does not use it must justify why it cannot race.
   */
  protected readonly _requests = new StaleGuard();

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

  override async dispose(): Promise<void> {
    this.__mounted = false;

    // Abort in-flight requests first, so a response landing after teardown
    // cannot write into a dead ViewModel.
    this._requests.cancelAll();

    for (const cleanup of this.#effectCleanups) {
      cleanup();
    }
    this.#effectCleanups = [];

    await super.dispose();
  }
}
