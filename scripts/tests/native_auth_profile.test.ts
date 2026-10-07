import { expect, test } from 'bun:test';
import { inspectNativeAuthProfile } from '../src/native/doctor.ts';

for (const profile of [undefined, '', 'legacy', 'supabase', 'supabse', 'LEGACY', ' ']) {
  test(`native doctor validates profile ${JSON.stringify(profile)}`, () => {
    const check = inspectNativeAuthProfile(profile);
    expect(check.severity).toBe('required');
    if (profile === undefined || profile === '' || profile === 'legacy') {
      expect(check.ok).toBe(true);
      expect(check.detail).toBe('legacy default');
    } else if (profile === 'supabase') {
      expect(check.detail).toContain('Supabase');
    } else {
      expect(check.ok).toBe(false);
      expect(check.remedy).toContain('legacy or supabase');
    }
  });
}
