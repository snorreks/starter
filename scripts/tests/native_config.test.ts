import { describe, expect, test } from 'bun:test';
import { assertNativeCsp, DEFAULT_DEV_API_ORIGIN } from '@starter/schemas/native';
import { nativeConfiguration, normalizeCi } from '../src/native/config.ts';

describe('the CI value the pinned Tauri CLI receives', () => {
  // tauri-cli 2.12.1 feeds the environment's CI straight to its boolean `--ci`
  // flag, so `CI=1` fails with "invalid value '1' for '--ci'" before compiling.
  test('a spelling the CLI cannot parse becomes a boolean it can', () => {
    for (const value of ['1', 'yes', 'on', 'TRUE', 'anything-else']) {
      expect(normalizeCi({ CI: value }).CI).toBe('true');
    }
    for (const value of ['', '0', 'false', 'FALSE', 'no', 'off']) {
      expect(normalizeCi({ CI: value }).CI).toBe('false');
    }
  });

  test('an absent CI stays absent, and nothing else in the environment is touched', () => {
    const env = { PATH: '/usr/bin', VITE_NATIVE_API_ORIGIN: 'https://api.example.test' };

    expect(normalizeCi(env)).toBe(env);
    expect(normalizeCi({ CI: '1', PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      CI: 'true',
    });
  });

  test('a build passes the normalized value, not the shell spelling', () => {
    const configured = nativeConfiguration('build', {
      CI: '1',
      VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
      VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co',
    });

    expect(configured.env.CI).toBe('true');
    expect(configured.env.VITE_NATIVE_API_ORIGIN).toBe('https://api.example.test');
  });
});

describe('the origin shared by the shell and frontend', () => {
  for (const mode of ['dev', 'build'] as const) {
    test(`${mode} normalizes the origin and generates both policies`, () => {
      const configured = nativeConfiguration(mode, {
        VITE_NATIVE_API_ORIGIN: ' https://API.Example.test:443/ ',
        VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co',
      });
      const security = JSON.parse(configured.config).app.security;
      expect(configured.env.VITE_NATIVE_API_ORIGIN).toBe('https://api.example.test');
      expect(configured.env.TAURI_CONFIG).toBe(configured.config);
      expect(security.csp).toContain(
        "connect-src 'self' ipc: http://ipc.localhost https://api.example.test https://project.supabase.co",
      );
      expect(security.devCsp).toBe(security.csp);
      expect(() =>
        assertNativeCsp(security.csp, configured.env.VITE_NATIVE_API_ORIGIN ?? '', [
          'https://project.supabase.co',
        ]),
      ).not.toThrow();
      expect(() => assertNativeCsp(security.csp, 'https://another.example.test')).toThrow(
        /disagree/,
      );
      expect(() => assertNativeCsp(`${security.csp} https:`, 'https://api.example.test')).toThrow(
        /disagree/,
      );
    });
  }

  test('development includes the default loopback origin', () => {
    const configured = nativeConfiguration('dev', {
      VITE_NATIVE_SUPABASE_URL: 'http://127.0.0.1:54321',
    });
    expect(configured.env.VITE_NATIVE_API_ORIGIN).toBe(DEFAULT_DEV_API_ORIGIN);
    expect(JSON.parse(configured.config).app.security.csp).toContain(DEFAULT_DEV_API_ORIGIN);
  });

  test('the native Supabase target adds exactly its configured Auth origin to the CSP', () => {
    const configured = nativeConfiguration('build', {
      VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
      VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co',
    });
    const csp = JSON.parse(configured.config).app.security.csp as string;
    expect(csp).toContain('https://api.example.test https://project.supabase.co');
    expect(() =>
      assertNativeCsp(csp, 'https://api.example.test', ['https://project.supabase.co']),
    ).not.toThrow();
    expect(() => assertNativeCsp(csp, 'https://api.example.test')).toThrow(/disagree/);
  });

  test('the native target refuses a missing or foreign shaped Supabase origin', () => {
    expect(() =>
      nativeConfiguration('build', {
        VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
      }),
    ).toThrow(/VITE_NATIVE_SUPABASE_URL/);
    expect(() =>
      nativeConfiguration('build', {
        VITE_NATIVE_API_ORIGIN: 'https://api.example.test',
        VITE_NATIVE_SUPABASE_URL: 'https://project.supabase.co/other',
      }),
    ).toThrow(/HTTPS origin/);
  });

  test('a build refuses a missing or insecure origin', () => {
    expect(() => nativeConfiguration('build', {})).toThrow(/No API origin/);
    expect(() =>
      nativeConfiguration('build', { VITE_NATIVE_API_ORIGIN: DEFAULT_DEV_API_ORIGIN }),
    ).toThrow(/https/);
  });

  test('missing, duplicate, or overbroad connection directives fail closed', () => {
    for (const csp of [
      '',
      "default-src 'self'",
      'connect-src https:',
      "connect-src 'self' ipc: http://ipc.localhost https://api.example.test; connect-src *",
    ]) {
      expect(() => assertNativeCsp(csp, 'https://api.example.test')).toThrow(/disagree/);
    }
  });
});
