// packages/frontend/ui/src/index.ts
//
// Shared presentational primitives. Deliberately small: only what two or more
// features actually use. A component that exists for one screen belongs next to
// that screen, in the application, until a second consumer appears.
//
// Prefer a subpath import (`@starter/ui/feedback`) over the barrel: the barrel
// pulls every component into every graph.

export * from './async_operation.svelte.ts';
export * from './dialogs.ts';
export * from './feedback/index.ts';
export * from './format.ts';
export * from './report_error.ts';
export * from './screen.ts';
export { default as ScreenContainer } from './screen_container.svelte';
