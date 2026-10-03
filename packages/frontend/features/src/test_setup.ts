// packages/frontend/features/src/test_setup.ts
//
// Preload for this package's Bun unit lane.
//
// The Bun runner has no Svelte compiler, so `$state` and friends do not exist.
// They are replaced with identity functions here. That is a real limitation, and it
// is why this lane does **not** test reactivity: a test that only stubs the runes
// proves nothing about them. The reactive half is proved in the web application's
// browser lane, which mounts these same components with the real compiler.
//
// What is deliberately absent matters as much as what is here:
//
//   - No `$app/*` mocks. The web application's own preload installs them, which is
//     why a shared module could once have imported `$app/navigation` and still
//     passed the app's unit tests. This package may not name `$app` at all, and the
//     cheapest way to keep that true is for the lane that proves it to have no
//     mock to hide behind.
//   - No environment variables. Nothing here reads one; a composition root does.
//
// What this file is for: pure logic, transport, and anything where calling a
// function is the honest way to test.

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
