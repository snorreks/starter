// apps/frontend/client/src/lib/test_setup.ts
//
// Preload for the Bun unit-test lane.
//
// The Bun runner has no Svelte compiler, so `$state` and friends do not exist.
// They are replaced with identity functions here. That is a real limitation, and
// it is why this lane does **not** test reactivity: a test that only stubs the
// runes proves nothing about them. Anything touching reactivity lives in the
// real-browser lane (`src/browser_tests`, run with `bun run test:browser`).
//
// What this lane *is* for: pure logic, transport, and anything where calling a
// function is the honest way to test.

import { mock } from 'bun:test';

/**
 * Assigned onto `globalThis` through a typed helper rather than by direct
 * property access: the runes are ambient globals that only exist after the
 * Svelte compiler has run, so they are declared here instead of being assumed.
 */
type RuneGlobals = Record<string, unknown>;

const globals = globalThis as RuneGlobals;

const identity = (value: unknown): unknown => value;
const noop = (): void => {};

// Svelte 5 runes, reduced to their value semantics. Built as locals first:
// attaching properties to a `Record<string, unknown>` entry is a type error, and
// the shapes are easier to see here than they would be through the record.
const state = Object.assign(identity, {
  raw: identity,
  snapshot: identity,
});

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

// `$app/*` has no Bun implementation. Mocked so an accidental import in a
// unit-tested module fails loudly rather than as "undefined is not a function".
mock.module('$app/navigation', () => ({
  goto: (): Promise<void> => Promise.resolve(),
  invalidateAll: (): Promise<void> => Promise.resolve(),
  invalidate: (): Promise<void> => Promise.resolve(),
  beforeNavigate: (): void => {},
  afterNavigate: (): void => {},
}));

mock.module('$app/state', () => ({
  page: {
    url: new URL('http://localhost/'),
    params: {},
    status: 200,
    error: null,
    data: {},
  },
}));

// Environment the runtime config reads. Matches `.env.example`'s local defaults.
process.env.PUBLIC_APP_ID = 'client';
process.env.PUBLIC_MODE = 'testing';
process.env.PUBLIC_LOG_LEVEL = 'ERROR';
process.env.PUBLIC_APP_VERSION = 'test';

// Keeps the unit lane quiet by default: the logger writes at DEBUG because the
// tests set PUBLIC_LOG_LEVEL themselves, and the output is noise. A test that
// wants it can restore the console.
const originalWarn = console.warn;
console.warn = noop;
globals.__restoreConsoleWarn = (): void => {
  console.warn = originalWarn;
};
