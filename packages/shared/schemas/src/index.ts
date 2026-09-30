// packages/shared/schemas/src/index.ts
//
// Portable, dependency-free contracts. Anything imported from here must be
// safe in a browser bundle, a Worker isolate and a Bun CLI simultaneously —
// that is why this package has no runtime dependency on any other project.
//
// Subpath imports (`@starter/schemas/notes`) are preferred over the barrel:
// the barrel pulls every schema into every graph.

export * from './common/index.ts';
export * from './logging/index.ts';
export * from './notes/index.ts';
export * from './auth/index.ts';
export * from './registry/index.ts';
