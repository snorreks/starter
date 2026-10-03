import { describe, expect, test } from 'bun:test';
import { assertNativeCsp, DEFAULT_DEV_API_ORIGIN } from '@starter/schemas/native';
import { nativeConfiguration } from '../src/native/config.ts';

describe('the origin shared by the shell and frontend', () => {
  for (const mode of ['dev', 'build'] as const) {
    test(`${mode} normalizes the origin and generates both policies`, () => {
      const configured = nativeConfiguration(mode, {
        VITE_NATIVE_API_ORIGIN: ' https://API.Example.test:443/ ',
      });
      const security = JSON.parse(configured.config).app.security;
      expect(configured.env.VITE_NATIVE_API_ORIGIN).toBe('https://api.example.test');
      expect(configured.env.TAURI_CONFIG).toBe(configured.config);
      expect(security.csp).toContain(
        "connect-src 'self' ipc: http://ipc.localhost https://api.example.test",
      );
      expect(security.devCsp).toBe(security.csp);
      expect(() =>
        assertNativeCsp(security.csp, configured.env.VITE_NATIVE_API_ORIGIN ?? ''),
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
    const configured = nativeConfiguration('dev', {});
    expect(configured.env.VITE_NATIVE_API_ORIGIN).toBe(DEFAULT_DEV_API_ORIGIN);
    expect(JSON.parse(configured.config).app.security.csp).toContain(DEFAULT_DEV_API_ORIGIN);
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
