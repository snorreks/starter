// packages/backend/database/src/index.ts
//
// Server-only. Importing this from frontend code is a layering violation
// (enforced by a Biome override and by the workspace-boundary guard): it pulls
// `drizzle-orm` and therefore database implementation into a browser bundle.

export * from './lib/d1_rate_limit.ts';
export * from './lib/schema.ts';
