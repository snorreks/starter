import type { SupabaseClient } from '@starter/database/supabase';
import type { VerifiedIdentity } from './identity.ts';

export interface SupabaseAccountConfig {
  origin: string;
  allowedCallbacks: readonly string[];
}

export interface SupabaseAccountUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface SupabaseAccountService {
  signUp(input: { email: string; password: string; name: string }): Promise<SupabaseAccountUser>;
  signIn(input: { email: string; password: string }): Promise<SupabaseAccountUser>;
  signOut(): Promise<void>;
  requestPasswordReset(input: { email: string; redirectTo: string }): Promise<void>;
  resetPassword(input: { newPassword: string }): Promise<void>;
  sendVerificationEmail(input: { email: string }): Promise<void>;
  changeEmail(input: { email: string }): Promise<void>;
  deleteAccount(identity: VerifiedIdentity): Promise<void>;
}

const requireResult = <T>(data: T, error: { message: string; status?: number } | null): T => {
  if (error) {
    throw Object.assign(new Error(`Supabase Auth request failed: ${error.message}`), {
      status: typeof error.status === 'number' ? error.status : 400,
    });
  }
  return data;
};

const projectUser = (
  user: {
    id: string;
    email?: string;
    email_confirmed_at?: string;
    user_metadata?: Record<string, unknown>;
  } | null,
): SupabaseAccountUser => {
  if (!user?.email) {
    throw new Error('Supabase Auth returned no verified account identity.');
  }
  const name = user.user_metadata?.display_name ?? user.user_metadata?.name;
  return {
    id: user.id,
    email: user.email,
    displayName: typeof name === 'string' ? name : user.email,
    emailVerified: typeof user.email_confirmed_at === 'string',
  };
};

const callbackUrl = (config: SupabaseAccountConfig, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//') || !config.allowedCallbacks.includes(path)) {
    throw new Error('Supabase Auth callback is not in the configured path allowlist.');
  }
  const callback = new URL('/auth/callback', config.origin);
  callback.searchParams.set('next', path);
  return callback.href;
};

export const createSupabaseAccountService = (
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  config: SupabaseAccountConfig,
): SupabaseAccountService => ({
  async signUp(input) {
    const { data, error } = await userClient.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: { display_name: input.name },
        emailRedirectTo: callbackUrl(config, '/verify-email'),
      },
    });
    const result = requireResult(data, error);
    return projectUser(result.user);
  },

  async signIn(input) {
    const { data, error } = await userClient.auth.signInWithPassword(input);
    const result = requireResult(data, error);
    return projectUser(result.user);
  },

  async signOut() {
    const { error } = await userClient.auth.signOut();
    requireResult(undefined, error);
  },

  async requestPasswordReset(input) {
    const redirectTo = callbackUrl(config, input.redirectTo);
    const { error } = await userClient.auth.resetPasswordForEmail(input.email, { redirectTo });
    requireResult(undefined, error);
  },

  async resetPassword(input) {
    const { error } = await userClient.auth.updateUser({ password: input.newPassword });
    requireResult(undefined, error);
  },

  async sendVerificationEmail(input) {
    const { error } = await userClient.auth.resend({
      type: 'signup',
      email: input.email,
      options: { emailRedirectTo: callbackUrl(config, '/verify-email') },
    });
    requireResult(undefined, error);
  },

  async changeEmail(input) {
    const { error } = await userClient.auth.updateUser(
      { email: input.email },
      { emailRedirectTo: callbackUrl(config, '/verify-email') },
    );
    requireResult(undefined, error);
  },

  async deleteAccount(identity) {
    if (identity.backend !== 'supabase') {
      throw new Error('Refusing to delete an account using a different backend identity.');
    }
    const { error } = await adminClient.auth.admin.deleteUser(identity.user.id);
    requireResult(undefined, error);
  },
});
