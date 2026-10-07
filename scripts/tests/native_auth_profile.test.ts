import { afterEach, expect, test } from 'bun:test';
import { inspectNative } from '../src/native/doctor.ts';

const original = process.env.VITE_NATIVE_AUTH_PROFILE;
afterEach(() => {
  if (original === undefined) {
    delete process.env.VITE_NATIVE_AUTH_PROFILE;
  } else {
    process.env.VITE_NATIVE_AUTH_PROFILE = original;
  }
});

for (const profile of [undefined, '', 'legacy', 'supabase', 'supabse', 'LEGACY', ' ']) {
  test(`native doctor validates profile ${JSON.stringify(profile)}`, () => {
    if (profile === undefined) {
      delete process.env.VITE_NATIVE_AUTH_PROFILE;
    } else {
      process.env.VITE_NATIVE_AUTH_PROFILE = profile;
    }
    const check = inspectNative().checks.find((entry) => entry.name === 'native auth profile');
    expect(check).toBeDefined();
    expect(check?.severity).toBe('required');
    if (profile === undefined || profile === '' || profile === 'legacy') {
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe('legacy default');
    } else if (profile === 'supabase') {
      expect(check?.detail).toContain('Supabase');
    } else {
      expect(check?.ok).toBe(false);
      expect(check?.remedy).toContain('legacy or supabase');
    }
  });
}
