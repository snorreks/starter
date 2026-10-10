// packages/shared/fixtures/src/index.ts
//
// Synthetic account and note records shared by local emulator entrypoints.

export const MOCK_USER = {
  id: 'seed_user_0001',
  email: 'seed@example.invalid',
  displayName: 'Seed User',
  provider: 'email' as const,
  emailVerified: true,
};

export const MOCK_NOTES = [
  {
    id: 'seed_note_0001',
    ownerId: MOCK_USER.id,
    title: 'Welcome',
    body: 'This note is synthetic seed data.',
    createdAt: 1_767_225_600_000,
    updatedAt: 1_767_225_600_000,
  },
  {
    id: 'seed_note_0002',
    ownerId: MOCK_USER.id,
    title: 'Delete me',
    body: 'This one exists so the delete path has something to act on.',
    createdAt: 1_767_225_600_000,
    updatedAt: 1_767_225_600_000,
  },
] as const;

/**
 * The synthetic identity `bun run dev` seeds into the local Supabase stack.
 *
 * One authority, because two places holding this password is one place forgetting
 * it: the seeder creates the account with these values, and the dev launcher's
 * auto sign-in presents the same ones. Nothing outside a loopback stack may use
 * it — the credential is public by construction, which is why every consumer
 * refuses it unless `SUPABASE_URL` is unambiguously this machine.
 *
 * `MOCK_USER` above is the same *idea* for the component-level scenarios, which
 * never reach an auth provider, so it keeps a readable id rather than a UUID.
 */
export const DEV_SEED_ACCOUNT = {
  userId: '10000000-0000-4000-8000-000000000001',
  email: 'seed@example.invalid',
  password: 'local-synthetic-seed-only',
  displayName: 'Seed User',
} as const;

/** The notes that land with `DEV_SEED_ACCOUNT`, owned by it. */
export const DEV_SEED_NOTES = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    owner_id: DEV_SEED_ACCOUNT.userId,
    title: 'Welcome',
    body: 'This note is synthetic local seed data.',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    owner_id: DEV_SEED_ACCOUNT.userId,
    title: 'Delete me',
    body: 'This synthetic note exists for local delete journeys.',
  },
] as const;

/** Portable content scenarios shared by browser and visual journeys. */
export const UI_SCENARIOS = {
  notes: {
    empty: [],
    populated: MOCK_NOTES.map(({ title, body }) => ({ title, body })),
    long: [
      {
        title: 'A deliberately long note title that wraps across a narrow viewport',
        body: 'Unicode remains readable: åäö — Καλημέρα — こんにちは — 👋\nSecond line, preserved.',
      },
    ],
    invalid: {
      title: 'x'.repeat(121),
      body: 'This title exceeds the committed note schema limit by one character.',
    },
  },
  chat: {
    conversationTitle: 'Weekend plans',
    prompt: 'Suggest a quiet Saturday plan with coffee and a walk.',
    response: 'Start with coffee, then take an easy walk somewhere green.',
  },
  media: {
    fixture: 'sample-v1',
    preset: 'demo-180p-v1',
    source: 'apps/backend/media/fixtures/media/sample-v1.mp4',
    output: { container: 'mp4', videoCodec: 'h264', width: 320, height: 180 },
  },
} as const;
