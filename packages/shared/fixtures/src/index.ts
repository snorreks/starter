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
