// apps/frontend/client/src/lib/features/notes/notes_view_model.test.ts
//
// Mutation lifecycle: writes that land after teardown, and overlapping
// optimistic deletions.
//
// Both are correctness bugs rather than cosmetic ones. A write that completes
// after `dispose()` mutates a ViewModel the container has already released; an
// overlapping delete rolls the list back to a snapshot taken before the *other*
// delete succeeded, resurrecting a row the server has already removed.
//
// The mutations here need no DOM, so they run in the Bun unit lane rather than
// the browser lane. That lane cannot run on this host (Chromium's shared
// libraries are absent), and making a correctness assertion wait on a browser
// would be the wrong trade anyway.

import { describe, expect, test } from 'bun:test';
import type { Note } from '@starter/schemas/notes';
import type { NotesService } from './notes_service.svelte.ts';
import { NotesViewModel } from './notes_view_model.svelte.ts';

/**
 * Distinct timestamps, so the ViewModel's newest-first sort produces a
 * deterministic order. Equal timestamps made the sort's stability the thing
 * under test instead of the rollback.
 */
const note = (id: string, ageSeconds = 0): Note => ({
  id,
  ownerId: 'user_1',
  title: id,
  body: 'body',
  createdAt: 1_700_000_000_000 - ageSeconds * 1000,
  updatedAt: 1_700_000_000_000 - ageSeconds * 1000,
});

/** A promise the test resolves or rejects by hand, so a race is reproducible. */
class Deferred {
  promise: Promise<void>;
  #resolve!: () => void;
  #reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(): void {
    this.#resolve();
  }

  reject(error: unknown): void {
    this.#reject(error);
  }
}

interface ServiceScript {
  list?: () => Promise<Note[]>;
  remove?: (id: string) => Promise<void>;
  create?: () => Promise<void>;
  update?: () => Promise<void>;
}

const service = (script: ServiceScript = {}): NotesService =>
  ({
    list: script.list ?? (() => Promise.resolve([])),
    remove: script.remove ?? (() => Promise.resolve()),
    create: script.create ?? (() => Promise.resolve()),
    update: script.update ?? (() => Promise.resolve()),
  }) as unknown as NotesService;

const ids = (model: NotesViewModel): string[] => model.notes.map((n) => n.id);

describe('NotesViewModel writes after disposal', () => {
  test('a delete completing after dispose does not restore state', async () => {
    const gate = new Deferred();
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 2), note('b', 1)]),
        remove: () => gate.promise,
      }),
    });

    await model.initialize();
    const deleting = model.deleteNote('a');
    expect(ids(model)).toEqual(['b']);

    await model.dispose();
    gate.reject(new Error('the request failed'));
    await deleting;

    // The list keeps the optimistic removal. Rolling back here would write into a
    // ViewModel the container has already released — and `a` would reappear in
    // state nobody can see, which is how a released ViewModel ends up diverged
    // from the server if it is ever inspected.
    expect(ids(model)).toEqual(['b']);
    expect(ids(model)).not.toContain('a');
    // The in-flight count must unwind even when teardown happened mid-write, or
    // the flag sticks on forever.
    expect(model.isMutating).toBe(false);
  });

  test('a delete completing after dispose does not resurrect an edit selection', async () => {
    const gate = new Deferred();
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 1)]),
        remove: () => gate.promise,
      }),
    });

    await model.initialize();
    model.startEditing('a');

    const deleting = model.deleteNote('a');
    await model.dispose();
    gate.resolve();
    await deleting;

    // The success path clears `editingId` after the await. Doing that on a disposed
    // ViewModel is the same class of write as the rollback above, so the guard
    // skips it: `editingId` keeps its pre-teardown value and `deleteNote` reports
    // false, because it cannot confirm anything on a released object.
    expect(model.editingId).toBe('a');
    expect(await model.deleteNote('a')).toBe(false);
  });

  test('a mutation after dispose is refused outright', async () => {
    let removed = 0;
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 1)]),
        remove: () => {
          removed += 1;
          return Promise.resolve();
        },
      }),
    });

    await model.initialize();
    await model.dispose();

    const accepted = await model.deleteNote('a');

    // Refusing is better than silently succeeding: a caller that asks a released
    // ViewModel to change something should be told, not allowed to believe it did.
    expect(accepted).toBe(false);
    expect(removed).toBe(0);
  });
});

describe('NotesViewModel overlapping optimistic deletions', () => {
  test('a failed delete does not resurrect a concurrent successful delete', async () => {
    const gateA = new Deferred();
    const gateB = new Deferred();

    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 2), note('b', 1)]),
        remove: (id) => (id === 'a' ? gateA.promise : gateB.promise),
      }),
    });

    await model.initialize();

    const deletingA = model.deleteNote('a');
    const deletingB = model.deleteNote('b');
    expect(ids(model)).toEqual([]);

    // B succeeds, then A fails. A's rollback snapshot was taken before B started,
    // so it still contains b — which would put a row back that the server deleted.
    gateB.resolve();
    await deletingB;
    gateA.reject(new Error('A failed'));
    await deletingA;

    expect(ids(model)).toEqual([]);
  });

  test('a delete that fails after a newer delete succeeded still restores its row', async () => {
    // The order the guard's commit has to be careful about.
    //
    // A is applied, then B. `#receipt` names B, because a second `apply`
    // overwrites it. If A succeeds and its `commit()` retires the slot
    // unconditionally, B's receipt is left holding a claim that has been cleared —
    // so when B then fails, its rollback sees `#receipt === null`, reads that as
    // "another write owns the list now", and yields. The row B removed stays gone
    // even though the server rejected the delete and the user was never told the
    // note came back.
    //
    // Reversed from the test above on purpose: there the *newer* delete settled
    // first, which the `applied` identity check already handled.
    const gateA = new Deferred();
    const gateB = new Deferred();
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 3), note('b', 2), note('c', 1)]),
        remove: (id) => (id === 'a' ? gateA.promise : gateB.promise),
      }),
    });

    await model.initialize();

    const deletingA = model.deleteNote('a');
    const deletingB = model.deleteNote('b');
    expect(ids(model)).toEqual(['c']);

    // A succeeds first, while B's receipt is the one holding the slot.
    gateA.resolve();
    expect(await deletingA).toBe(true);
    expect(ids(model)).toEqual(['c']);

    // B then fails. Its row must come back — the server still has it.
    gateB.reject(new Error('B failed'));
    expect(await deletingB).toBe(false);

    // c was deleted by the server. b was not, and the failed delete said so.
    expect([...ids(model)].sort()).toEqual(['b', 'c']);
    expect(ids(model)).not.toContain('a');
  });

  test('a failed delete restores only its own row', async () => {
    const gate = new Deferred();
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 3), note('b', 2), note('c', 1)]),
        remove: () => gate.promise,
      }),
    });

    await model.initialize();

    // Newest first: c, b, a.
    const deleting = model.deleteNote('b');
    expect(ids(model)).toEqual(['c', 'a']);

    gate.reject(new Error('failed'));
    await deleting;

    // Only b comes back. This is the behaviour that has to survive the fix above:
    // a rollback restores its own row and nothing else.
    expect(ids(model)).toContain('b');
    expect([...ids(model)].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a reload during a pending delete wins over the delete', async () => {
    const gate = new Deferred();
    let listCalls = 0;

    const model = new NotesViewModel({
      notes: service({
        list: () => {
          listCalls += 1;
          // The server has already removed a by the time this is called.
          return Promise.resolve(listCalls === 1 ? [note('a', 2), note('b', 1)] : [note('b', 1)]);
        },
        remove: () => gate.promise,
      }),
    });

    await model.initialize();

    const deleting = model.deleteNote('a');
    const reloading = model.load();

    gate.resolve();
    await Promise.all([deleting, reloading]);

    // The reload is the server's answer. It must not be overwritten by the delete's
    // optimistic state or its rollback.
    expect(ids(model)).toEqual(['b']);
  });

  test('isMutating stays true while any mutation is in flight', async () => {
    const gateA = new Deferred();
    const gateB = new Deferred();
    const model = new NotesViewModel({
      notes: service({
        list: () => Promise.resolve([note('a', 2), note('b', 1)]),
        remove: (id) => (id === 'a' ? gateA.promise : gateB.promise),
      }),
    });

    await model.initialize();

    const deletingA = model.deleteNote('a');
    const deletingB = model.deleteNote('b');
    expect(model.isMutating).toBe(true);

    gateA.resolve();
    await deletingA;

    // One of two is still outstanding, so the flag must not have cleared.
    expect(model.isMutating).toBe(true);

    gateB.resolve();
    await deletingB;
    expect(model.isMutating).toBe(false);
  });
});

describe('NotesViewModel disposal state', () => {
  for (const operation of ['create', 'update'] as const) {
    test(`${operation} completing after disposal returns false without reloading`, async () => {
      const gate = new Deferred();
      let loads = 0;
      const model = new NotesViewModel({
        notes: service({
          list: async () => {
            loads += 1;
            return [note('a')];
          },
          [operation]: () => gate.promise,
        }),
      });
      await model.initialize();
      const pending =
        operation === 'create'
          ? model.createNote({ title: 'new', body: '' })
          : model.updateNote('a', { title: 'updated' });
      await model.dispose();
      gate.resolve();
      expect(await pending).toBe(false);
      expect(loads).toBe(1);
      expect(model.isMutating).toBe(false);
    });
  }

  test('a disposed ViewModel refuses a load', async () => {
    let listCalls = 0;
    const model = new NotesViewModel({
      notes: service({
        list: () => {
          listCalls += 1;
          return Promise.resolve([note('a')]);
        },
      }),
    });

    await model.initialize();
    expect(listCalls).toBe(1);

    await model.dispose();
    await model.load();

    expect(listCalls).toBe(1);
  });

  test('disposing twice is not an error', async () => {
    const model = new NotesViewModel({ notes: service() });
    await model.initialize();

    await model.dispose();
    await model.dispose();

    expect(model.isMutating).toBe(false);
  });
});
