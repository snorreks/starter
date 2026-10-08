import { expect, test } from 'bun:test';
import { inspectNativeAuthProfile } from '../src/native/doctor.ts';

const valid = {
  VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
  VITE_NATIVE_ENVIRONMENT: 'test',
  VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_NATIVE_SUPABASE_PROJECT_REF: 'project',
  VITE_NATIVE_SUPABASE_ANON_KEY: 'synthetic-public-key',
};

test('native doctor requires Supabase public configuration by default', () => {
  const check = inspectNativeAuthProfile({ env: {} });
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('VITE_NATIVE_SUPABASE_URL');
});

test('native doctor accepts a complete Supabase target by default or explicitly', () => {
  expect(inspectNativeAuthProfile({ env: valid }).ok).toBe(true);
  expect(inspectNativeAuthProfile({ profile: 'supabase', env: valid }).ok).toBe(true);
});

test('native doctor rejects legacy and unknown profiles', () => {
  for (const profile of ['legacy', 'supabse', 'LEGACY', ' ']) {
    expect(inspectNativeAuthProfile({ profile, env: valid }).ok).toBe(false);
  }
});
