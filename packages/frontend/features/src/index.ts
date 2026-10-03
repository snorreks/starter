// packages/frontend/features/src/index.ts
//
// The shared frontend features.
//
// Two features live here today — notes and the account screen — and both are
// `browser`-plane modules that any host can render: the SSR web application now,
// a static native bundle later. What makes that possible is a rule enforced
// twice (Biome's frontend override and `bun run guard`): nothing in this package
// may import `$app/*`, `@tauri-apps/*`, a Cloudflare binding, `@starter/database`,
// `@starter/auth`, or anything under `apps/` or `scripts/`.
//
// A feature that needs one of those is not portable, and the fix is a composition
// root in the host that has it — which is what
// `apps/frontend/client/src/lib/composition/` contains today.
//
// Subpath exports (`./notes`, `./auth`) are published so a host imports the
// feature it renders rather than the barrel, and a bundle cannot pull in a screen
// it will never mount.

export * from './auth/index.ts';
export * from './notes/index.ts';
