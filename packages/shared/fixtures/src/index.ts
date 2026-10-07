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
