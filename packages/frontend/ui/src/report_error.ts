// packages/frontend/ui/src/report_error.ts
//
// Turning a thrown value into something a person should read.
//
// This was `BaseFrontendClass.showErrorNotification`, a protected method on a base
// class two ViewModels inherited. Its three behaviours are worth keeping and none
// of them needs a class:
//
//   - classify the error, so the message is about the failure rather than the
//     exception's class name;
//   - stay silent for a cancelled request, because a message that appears when the
//     user navigated away trains them to ignore messages;
//   - route the text to whatever surface the application installed.
//
// Importable from anywhere a browser runs, which is the whole difference: a
// ViewModel can now compose this without inheriting it, and a client service can
// use it too.

import { toAppError } from '@starter/utils';
import { showSnackbar } from './dialogs.ts';

/**
 * Classify, log-worthy detail aside, and report `error`.
 */
export const reportError = (error: unknown, fallbackMessage = 'Something went wrong.'): void => {
  const appError = toAppError(error, fallbackMessage);

  // A cancelled request is not a failure. The user pressed something and moved on;
  // a red banner about it is noise, and noise here costs the credibility the next
  // real error message needs.
  if (appError.errorType === 'aborted') {
    return;
  }

  showSnackbar(appError.message, 'error');
};
