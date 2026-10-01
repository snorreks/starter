// packages/backend/database/drizzle.config.ts
//
// Drizzle Kit configuration. `dialect: 'sqlite'` because the only target is
// Cloudflare D1, which is SQLite. Migrations are generated into `drizzle-d1/`
// and applied by `wrangler d1 migrations apply` (see scripts/src/db).

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/schema.ts',
  out: './drizzle-d1',
  strict: true,
  verbose: true,
});
