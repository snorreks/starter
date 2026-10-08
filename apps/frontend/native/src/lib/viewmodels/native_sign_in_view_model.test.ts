import { describe, expect, test } from 'bun:test';
import {
  type NativeSignInOptions,
  NativeSignInViewModel,
} from './native_sign_in_view_model.svelte.ts';

const fixture = (overrides: Partial<NativeSignInOptions> = {}) => {
  const calls: string[] = [];
  const viewModel = new NativeSignInViewModel({
    apiOrigin: 'https://api.example.test',
    session: { user: null },
    activeVault: { isAvailable: async () => false },
    refreshSession: async () => {
      calls.push('restore');
    },
    requiresReauthentication: () => false,
    hasSession: () => false,
    unlockSupabaseVault: async () => {
      calls.push('unlock');
    },
    beginSupabaseOAuth: async () => {
      calls.push('oauth');
    },
    nativeNavigation: {
      go: async (path) => {
        calls.push(path);
      },
    },
    ...overrides,
  });
  return { viewModel, calls };
};

describe('native sign-in decisions', () => {
  test('allows another OAuth attempt when the browser flow never returns', async () => {
    const { viewModel, calls } = fixture();
    await viewModel.signInWithBrowser();
    expect(viewModel.phase).toBe('signed-out');
    expect(viewModel.statusText).toContain('Complete sign-in in your browser.');
    await viewModel.signInWithBrowser();
    expect(calls).toEqual(['oauth', 'oauth']);
  });

  test('browser startup failure releases the waiting phase', async () => {
    const { viewModel } = fixture({
      beginSupabaseOAuth: async () => {
        throw new Error('Browser unavailable');
      },
    });
    await viewModel.signInWithBrowser();
    expect(viewModel.busy).toBe(false);
    expect(viewModel.errorText).toBe('Browser unavailable');
  });

  test('missing passphrase releases the button without starting OAuth', async () => {
    const { viewModel, calls } = fixture();
    viewModel.remember = true;
    await viewModel.signInWithBrowser();
    expect(viewModel.busy).toBe(false);
    expect(viewModel.errorText).toContain('Enter a passphrase');
    expect(calls).toEqual([]);
  });

  test('unlocking a restored identity navigates without starting a second sign-in', async () => {
    const { viewModel, calls } = fixture({ hasSession: () => true });
    viewModel.remember = true;
    viewModel.passphrase = 'synthetic passphrase';
    await viewModel.signInWithBrowser();
    expect(calls).toEqual(['unlock', '/notes']);
    expect(viewModel.passphrase).toBe('');
    expect(viewModel.vaultAvailable).toBe(true);
    expect(viewModel.busy).toBe(false);
  });

  test('keeps authenticated phase and clears status when navigation fails after unlock', async () => {
    const { viewModel } = fixture({
      hasSession: () => true,
      nativeNavigation: {
        go: async () => {
          throw new Error('Navigation unavailable');
        },
      },
    });
    viewModel.remember = true;
    viewModel.passphrase = 'synthetic passphrase';
    viewModel.statusText = 'stale status';

    await viewModel.signInWithBrowser();

    expect(viewModel.phase).toBe('authenticated');
    expect(viewModel.statusText).toBe('');
    expect(viewModel.errorText).toBe('Signed in, but could not open notes: Navigation unavailable');
    expect(viewModel.busy).toBe(false);
  });

  test('maps legacy credential removal after initialization and vault unlock', async () => {
    let reauthentication = false;
    const { viewModel, calls } = fixture({
      refreshSession: async () => {
        reauthentication = true;
      },
      requiresReauthentication: () => reauthentication,
    });
    await viewModel.initialize();
    expect(viewModel.reauthenticationRequired).toBe(true);
    viewModel.remember = true;
    viewModel.passphrase = 'synthetic passphrase';
    await viewModel.signInWithBrowser();
    expect(calls).toEqual(['unlock', 'oauth']);
    expect(viewModel.reauthenticationRequired).toBe(true);
  });
});
