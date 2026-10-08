import { expect, test } from 'bun:test';
import { inspectNativeSupabaseConfiguration } from '../src/native/doctor.ts';

test('native doctor requires the Supabase public target without a profile selector', () => {
  const check = inspectNativeSupabaseConfiguration({});
  expect(check.severity).toBe('required');
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('VITE_NATIVE_API_ORIGIN');
  expect(check.remedy).toContain('Set these public target values');
});

test('native doctor accepts a complete Supabase target', () => {
  const check = inspectNativeSupabaseConfiguration({
    VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
    VITE_NATIVE_ENVIRONMENT: 'staging',
    VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co',
    VITE_NATIVE_SUPABASE_PROJECT_REF: 'project',
    VITE_NATIVE_SUPABASE_ANON_KEY: 'public-key',
  });
  expect(check).toMatchObject({ ok: true, detail: 'Supabase native target configured' });
});
