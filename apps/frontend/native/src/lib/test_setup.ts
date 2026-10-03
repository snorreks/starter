// apps/frontend/native/src/lib/test_setup.ts
// Preload for the Bun unit-test lane.
//
// The Bun runner has no Svelte compiler, so the runes do not exist. They are
// replaced with identity functions here, which is why this lane tests *logic* —
// configuration validation, the transport's headers, the vault's rules, the URL
// allowance — and not components. A test that only stubs the runes proves nothing
// about them.
//
// `$app/navigation` is mocked so an accidental import fails loudly rather than as
// "undefined is not a function", and `@tauri-apps/*` is NOT mocked: the two files
// that use it are the ones a shell is needed for, and they are exercised by the
// packaged build and by `bun run native:doctor`, not here. The rules those files
// implement live one layer down, in modules that have no Tauri import at all.

import { mock } from 'bun:test';

type RuneGlobals = Record<string, unknown>;

const globals = globalThis as RuneGlobals;

const identity = (value: unknown): unknown => value;
const noop = (): void => {};

const state = Object.assign(identity, { raw: identity, snapshot: identity });
const derived = Object.assign(identity, { by: identity });
const effect = Object.assign(noop, {
  pre: noop,
  root: (fn: () => void): (() => void) => {
    fn();
    return noop;
  },
});

globals.$state = state;
globals.$derived = derived;
globals.$effect = effect;

mock.module('$app/navigation', () => ({
  goto: (): Promise<void> => Promise.resolve(),
  invalidateAll: (): Promise<void> => Promise.resolve(),
  invalidate: (): Promise<void> => Promise.resolve(),
}));

// `#lib/runtime/config.ts` builds its config at module evaluation, and a packaged
// build refuses to evaluate without an API origin — which is the behaviour the
// config tests assert through `resolveApiOrigin`. This preload therefore has to
// supply one, or importing the module anywhere in this lane is an unhandled
// error rather than a failed assertion. Bun exposes `process.env` as
// `import.meta.env`, which is how Vite's replaced values are read back here.
//
// The value is a fixture, not a deployment target: nothing in this lane opens a
// socket, and `bearer_transport.test.ts` injects its own `fetch`.
process.env.VITE_NATIVE_API_ORIGIN = 'https://api.example.test';
process.env.VITE_NATIVE_CLIENT_ID = 'starter-native-desktop-test';
