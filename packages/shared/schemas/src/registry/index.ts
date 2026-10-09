// packages/shared/schemas/src/registry/index.ts
//
// Origin policy only.
//
// The tooling's project registry — Worker names, Supabase project ids, log adapter topology —
// moved to `scripts/src/registry/`. None of it crosses a wire or runs in a
// browser, so shipping it from here meant every frontend build carried deployment
// configuration it never read.

export * from './origins.ts';
