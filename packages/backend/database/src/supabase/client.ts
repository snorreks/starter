import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.ts';

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}
export interface SupabaseAdminConfig extends SupabasePublicConfig {
  serviceRoleKey: string;
}

export const createUserDatabaseClient = (
  config: SupabasePublicConfig,
  accessToken: string,
): SupabaseClient<Database> =>
  createClient<Database>(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

export const createAdminDatabaseClient = (config: SupabaseAdminConfig): SupabaseClient<Database> =>
  createClient<Database>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

export type { SupabaseClient };
