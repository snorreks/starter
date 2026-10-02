// packages/frontend/ui/src/dialogs.ts
//
// Application-level feedback surfaces, installed once by the root layout.
//
// Why this is a registered capability rather than a service instance
// -----------------------------------------------------------------
// A ViewModel cannot import the root layout — that is a cycle, and it would make a
// screen unusable outside this application's shell. What it needs is a way to say
// "tell the user something went wrong" without knowing how. That is a capability,
// so it is registered here and looked up at call time.
//
// The lookup is on `globalThis` because this is a browser-only package and the
// installer runs in a component. A module-level binding would work in exactly the
// same way and would additionally be reachable from a second module instance,
// which in a bundled app is a bug that appears only after a code-split changes
// the chunk graph.
//
// `undefined` is a legitimate answer, not an error. A screen mounted in a test, or
// in isolation, has no shell to talk to; every function below degrades to doing
// nothing rather than throwing.

export interface Snackbar {
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface DialogCapability {
  showSnackbar(snackbar: Snackbar): void;
  confirm(options: { title: string; body: string; confirmLabel?: string }): Promise<boolean>;
}

type GlobalWithDialogs = typeof globalThis & { __starterDialogs?: DialogCapability };

/** Install the capability. Called once, from `+layout.svelte`. */
export const setDialogCapabilities = (capabilities: DialogCapability | undefined): void => {
  (globalThis as GlobalWithDialogs).__starterDialogs = capabilities;
};

export const getDialogCapabilities = (): DialogCapability | undefined =>
  (globalThis as GlobalWithDialogs).__starterDialogs;

export const showSnackbar = (text: string, tone: Snackbar['tone'] = 'info'): void => {
  getDialogCapabilities()?.showSnackbar({ text, tone });
};

/**
 * Ask the user to confirm something irreversible.
 *
 * Defaults to `false`. A confirm dialog that resolves `true` when no shell is
 * mounted would make "no feedback surface" indistinguishable from "the user said
 * yes", and the second reading loses data.
 */
export const confirmWithUser = async (options: {
  title: string;
  body: string;
  confirmLabel?: string;
}): Promise<boolean> => {
  return (await getDialogCapabilities()?.confirm(options)) ?? false;
};
