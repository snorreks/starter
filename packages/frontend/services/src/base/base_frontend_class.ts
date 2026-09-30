// packages/frontend/services/src/base/base_frontend_class.svelte.ts
//
// Shared behaviour for anything the user can be notified about.
//
// Dialog and snackbar access goes through a capability object rather than a
// global event bus or a direct import of the app's component tree. That is what
// keeps a ViewModel unit-testable: the test injects a recorder, and no
// component has to be mounted to assert that an error was surfaced.

import {
  type AppError,
  BaseClass,
  type BaseClassInterface,
  type BaseClassOptions,
  toAppError,
} from '@starter/utils';

/** A transient message shown to the user. */
export interface Snackbar {
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface DialogCapability {
  showSnackbar(snackbar: Snackbar): void;
  confirm(options: { title: string; body: string; confirmLabel?: string }): Promise<boolean>;
  /** Route the user to sign-in, preserving where they were. */
  requestSignIn(): void;
}

type GlobalWithDialogs = typeof globalThis & { __starterDialogs?: DialogCapability };

/**
 * The app installs its implementation once at startup. Before that, calls are
 * no-ops rather than throws: a notification is not a reason to fail a command,
 * and a unit test that does not care about snackbars should not have to know.
 */
const dialogs = (): DialogCapability | undefined =>
  (globalThis as GlobalWithDialogs).__starterDialogs;

export const setDialogCapabilities = (capabilities: DialogCapability | undefined): void => {
  (globalThis as GlobalWithDialogs).__starterDialogs = capabilities;
};

export type BaseFrontendClassOptions = BaseClassOptions;

export type BaseFrontendClassInterface = BaseClassInterface;

export abstract class BaseFrontendClass<
    Options extends BaseFrontendClassOptions = BaseFrontendClassOptions,
  >
  extends BaseClass<Options>
  implements BaseFrontendClassInterface
{
  protected showSnackbar(text: string, tone: Snackbar['tone'] = 'info'): void {
    dialogs()?.showSnackbar({ text, tone });
  }

  protected async openConfirmDialog(options: {
    title: string;
    body: string;
    confirmLabel?: string;
  }): Promise<boolean> {
    return (await dialogs()?.confirm(options)) ?? false;
  }

  protected requestSignIn(): void {
    dialogs()?.requestSignIn();
  }

  /**
   * Report a failure to the user and record it.
   *
   * Every rejection path in a command should end here. The alternative —
   * letting a rejection propagate — produces an unhandled promise rejection
   * that reads as a crash with no indication of which command failed.
   */
  protected showErrorNotification(
    error: unknown,
    fallbackMessage = 'Something went wrong.',
  ): AppError {
    const appError = toAppError(error, fallbackMessage);

    // A cancelled request is not a failure; reporting it trains users to
    // ignore error messages.
    if (appError.errorType === 'aborted') {
      this.debug('suppressed notification for cancelled request');
      return appError;
    }

    this.error(appError.message, appError);
    this.showSnackbar(appError.message, 'error');

    return appError;
  }

  /**
   * Run a command, surfacing its failure and returning whether it succeeded.
   *
   * Returns a boolean rather than rethrowing so a view can branch without a
   * try/catch around every handler.
   */
  protected async runCommand(
    command: () => Promise<unknown>,
    options: { failureMessage?: string } = {},
  ): Promise<boolean> {
    try {
      await command();
      return true;
    } catch (error) {
      this.showErrorNotification(error, options.failureMessage);
      return false;
    }
  }
}
