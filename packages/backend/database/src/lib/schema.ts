// packages/backend/database/src/lib/schema.ts
//
// Drizzle schema for Cloudflare D1 (SQLite).
//
// Deliberately small: the Better Auth tables plus one owned domain table.
// Drizzle is used directly at the call site — there is no
// repository/controller/service wrapper, because such a layer that only
// restates a `select()` adds a file and an indirection without adding a rule.
//
// D1 is SQLite, so everything below is SQLite dialect. `integer(...,
// { mode: 'timestamp' })` gives epoch-millisecond Date columns.

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// -----------------------------------------------------------------------------
// Better Auth tables
//
// These tables are owned by Better Auth's expectations, not by this project.
// Round 1 enables email + password only — no OAuth provider, no email
// verification — but the schema still carries the OAuth columns and the
// device-code table, because Better Auth validates its expected shape against
// the adapter at runtime and refuses to start when it is incomplete.
//
// That is worth stating plainly: removing them would "simplify" the schema and
// break sign-in at runtime, not at build time. Better Auth checks
// `dist/db/schema.mjs` and `plugins/device-authorization/schema.mjs`.
// -----------------------------------------------------------------------------

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  /** FK to `users.id`. Cascade is correct: a session cannot outlive its user. */
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `"credential"` for email+password. Other providers are not enabled. */
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Scrypt hash. `null` for a provider that does not use a password. */
    password: text('password'),
    // Present because Better Auth requires the columns, unused because no OAuth
    // provider is configured. Documented rather than quietly present.
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('accounts_user_provider_account_idx').on(
      table.userId,
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/**
 * Device-authorization codes, for the Tauri client.
 *
 * Not optional: the desktop webview cannot OAuth-popup, so it signs in by
 * presenting a short user code the user approves in a browser. See @starter/auth.
 */
export const deviceCodes = sqliteTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    /** `pending` | `approved` | `denied`. */
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('device_codes_device_code_idx').on(table.deviceCode),
    uniqueIndex('device_codes_user_code_idx').on(table.userCode),
  ],
);

// -----------------------------------------------------------------------------
// Domain: notes
// -----------------------------------------------------------------------------

/**
 * A user-owned note.
 *
 * The ownership index is not decoration: every read and every write filters on
 * `owner_id`, and this index is what makes that filter cheap as a user
 * accumulates notes. It is the index the authorization test exercises.
 */
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    /** FK to `users.id`. Cascade: deleting an account deletes its notes. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('notes_owner_id_idx').on(table.ownerId),
    index('notes_owner_updated_idx').on(table.ownerId, table.updatedAt),
  ],
);

// -----------------------------------------------------------------------------
// Row types
//
// Derived from the schema, never hand-written alongside it: a parallel
// hand-maintained type is exactly how a migration and a type drift apart.
// -----------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type NewNoteRow = typeof notes.$inferInsert;

/**
 * Column->table map handed to Better Auth's Drizzle adapter. The adapter looks
 * tables up by its own singular model names (`user`, `session`, ...), which do
 * not match the exported variable names, hence this explicit map.
 */
export const betterAuthSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  deviceCode: deviceCodes,
} as const;
