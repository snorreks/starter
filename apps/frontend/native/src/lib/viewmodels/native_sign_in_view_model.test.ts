import { describe, expect, test } from 'bun:test';
import {
  type NativeSignInOptions,
  NativeSignInViewModel,
} from './native_sign_in_view_model.svelte.ts';

const unexpected = async (): Promise<never> => {
  throw new Error('Unexpected legacy operation');
};
const fixture = (overrides: Partial<NativeSignInOptions> = {}) => {
  const calls: string[] = [];
  const viewModel = new NativeSignInViewModel({
    authProfile: 'supabase',
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
    unlockVault: unexpected,
    beginSupabaseOAuth: async () => {
      calls.push('oauth');
    },
    authSessionService: { refresh: unexpected, signOut: unexpected },
    deviceService: { requestCode: unexpected, awaitApproval: unexpected },
    externalBrowser: { open: unexpected },
    adoptSession: unexpected,
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

  test('legacy denial keeps the existing device flow and its terminal message', async () => {
    const { viewModel } = fixture({
      authProfile: 'legacy',
      deviceService: {
        requestCode: async () => ({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://api.example.test/device',
          verification_uri_complete: 'https://api.example.test/device?code=CODE',
          expires_in: 600,
          interval: 5,
        }),
        awaitApproval: async () => ({ status: 'denied' }),
      },
      externalBrowser: { open: async () => {} },
    });
    await viewModel.signInWithBrowser();
    expect(viewModel.userCode).toBe('CODE');
    expect(viewModel.phase).toBe('denied');
    expect(viewModel.errorText).toContain('denied in the browser');
  });
});
