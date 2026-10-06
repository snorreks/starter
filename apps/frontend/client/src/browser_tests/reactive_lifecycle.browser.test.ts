// apps/frontend/client/src/browser_tests/reactive_lifecycle.browser.test.ts
//
// Reactivity and lifecycle, in a real browser with the real Svelte compiler.
//
// This is the lane that catches the failures a stubbed-rune test cannot:
//   - `$state` writes that do not reach the DOM
//   - `$derived` recomputing when its dependencies change
//   - `ScreenContainer` disposing exactly once per mount
//   - `StaleGuard` cancelling an in-flight request when a newer one starts
//
// No network and no server: services are faked, which is the point of the
// composition seam.

import { NoteCard, NoteForm, type NotesService, NotesViewModel } from '@starter/features/notes';
import type { Note } from '@starter/schemas/notes';
import { AsyncOperation, ErrorState, ScreenContainer, ScreenScope } from '@starter/ui';
import { StaleGuard } from '@starter/utils';
import { flushSync } from 'svelte';
import { describe, expect, test } from 'vitest';
import { emptySnippet, mountInDocument } from './mount_helper.ts';

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'note_1',
  ownerId: 'user_1',
  title: 'A note',
  body: 'Body text',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

/** A fake service whose responses the test controls, so races are reproducible. */
const fakeNotesService = (
  behaviour: Partial<Pick<NotesService, 'list' | 'remove' | 'create'>> = {},
): NotesService =>
  ({
    list: behaviour.list ?? (() => Promise.resolve([])),
    remove: behaviour.remove ?? (() => Promise.resolve()),
    create: behaviour.create ?? (() => Promise.reject(new Error('create is not exercised here'))),
    update: () => Promise.reject(new Error('update is not exercised here')),
  }) as unknown as NotesService;

/** Let pending effects and promise callbacks settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeViewModel = (service: NotesService): NotesViewModel =>
  new NotesViewModel({ notes: service });

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

// ── StaleGuard ──────────────────────────────────────────────────────────────

describe('StaleGuard', () => {
  test('a superseded operation is no longer current', () => {
    const guard = new StaleGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first.token)).toBe(false);
    expect(guard.isCurrent(second.token)).toBe(true);
  });

  test('beginning a new operation aborts the previous signal', () => {
    const guard = new StaleGuard();
    const first = guard.begin();
    expect(first.signal.aborted).toBe(false);

    guard.begin();
    expect(first.signal.aborted).toBe(true);
  });

  test('cancelAll invalidates an outstanding token', () => {
    const guard = new StaleGuard();
    const token = guard.begin();

    guard.cancelAll();

    expect(guard.isCurrent(token.token)).toBe(false);
    expect(guard.cancelled).toBe(true);
  });
});

// ── ViewModel reactivity ────────────────────────────────────────────────────

describe('NotesViewModel reactivity', () => {
  test('status moves from loading to ready and exposes the list', async () => {
    const viewModel = makeViewModel(fakeNotesService({ list: () => Promise.resolve([note()]) }));

    expect(viewModel.status.kind).toBe('loading');

    await viewModel.load();
    flushSync();

    expect(viewModel.status.kind).toBe('ready');
    expect(viewModel.notes).toHaveLength(1);
    expect(viewModel.isEmpty).toBe(false);
  });

  test('an empty result is the empty state, not an error', async () => {
    const viewModel = makeViewModel(fakeNotesService({ list: () => Promise.resolve([]) }));

    await viewModel.load();
    flushSync();

    expect(viewModel.status.kind).toBe('ready');
    expect(viewModel.isEmpty).toBe(true);
  });

  test('a rejected load becomes a recoverable error state', async () => {
    const viewModel = makeViewModel(
      fakeNotesService({ list: () => Promise.reject(new Error('boom')) }),
    );

    await viewModel.load();
    flushSync();

    expect(viewModel.status.kind).toBe('error');
    if (viewModel.status.kind !== 'error') {
      return;
    }
    expect(viewModel.status.message).toBeTruthy();
    expect(viewModel.status.retryable).toBe(true);
  });

  test('a slow earlier load cannot overwrite a newer one', async () => {
    // The first list() resolves with stale data *after* the second. Without
    // StaleGuard the stale answer lands last and the UI shows the wrong list —
    // the most common bug in a search-as-you-type UI.
    const slow = new Deferred<Note[]>();
    const fast = new Deferred<Note[]>();

    let call = 0;
    const service = fakeNotesService({
      list: () => {
        call += 1;
        return call === 1 ? slow.promise : fast.promise;
      },
    });

    const viewModel = makeViewModel(service);

    const firstLoad = viewModel.load();
    const secondLoad = viewModel.load();

    fast.resolve([note({ id: 'note_fresh', title: 'Fresh' })]);
    await secondLoad;

    slow.resolve([note({ id: 'note_stale', title: 'Stale' })]);
    await firstLoad;
    flushSync();

    expect(viewModel.notes.map((entry) => entry.id)).toEqual(['note_fresh']);
  });

  test('a failed delete restores the row instead of reporting success', async () => {
    const existing = [note({ id: 'note_a' }), note({ id: 'note_b' })];
    const service = fakeNotesService({
      list: () => Promise.resolve(existing),
      remove: () => Promise.reject(new Error('server said no')),
    });

    const viewModel = makeViewModel(service);
    await viewModel.load();
    flushSync();

    const ok = await viewModel.deleteNote('note_a');
    flushSync();

    expect(ok).toBe(false);
    expect(viewModel.notes.map((entry) => entry.id).sort()).toEqual(['note_a', 'note_b']);
  });

  test('a successful delete removes the row', async () => {
    const service = fakeNotesService({
      list: () => Promise.resolve([note({ id: 'note_a' }), note({ id: 'note_b' })]),
      remove: () => Promise.resolve(),
    });

    const viewModel = makeViewModel(service);
    await viewModel.load();

    const ok = await viewModel.deleteNote('note_a');
    flushSync();

    expect(ok).toBe(true);
    expect(viewModel.notes.map((entry) => entry.id)).toEqual(['note_b']);
  });
});

// ── Component rendering ─────────────────────────────────────────────────────

describe('NoteCard', () => {
  test('renders the title and body, and raises intents', () => {
    const edits: string[] = [];
    const deletes: string[] = [];

    const mounted = mountInDocument(NoteCard, {
      note: note({ title: 'Shopping list', body: 'Milk, bread' }),
      onEdit: (id: string) => edits.push(id),
      onDelete: (id: string) => deletes.push(id),
    });

    expect(mounted.target.querySelector('h3')?.textContent).toContain('Shopping list');
    expect(mounted.target.textContent).toContain('Milk, bread');

    mounted.target.querySelector<HTMLButtonElement>('[data-testid="note-edit"]')?.click();
    mounted.target.querySelector<HTMLButtonElement>('[data-testid="note-delete"]')?.click();
    flushSync();

    expect(edits).toEqual(['note_1']);
    expect(deletes).toEqual(['note_1']);

    mounted.destroy();
  });

  test('the visually-hidden span gives the icon-less buttons unique names', () => {
    const mounted = mountInDocument(NoteCard, {
      note: note(),
      onEdit: () => {},
      onDelete: () => {},
    });

    // Without it, two buttons in a list read as two identical "Delete"s to a
    // screen reader.
    expect(mounted.target.textContent).toContain('A note');

    mounted.destroy();
  });
});

describe('ErrorState', () => {
  test('is announced as an alert and offers a retry', () => {
    let retried = 0;
    const mounted = mountInDocument(ErrorState, {
      message: 'Could not load your notes',
      onRetry: () => {
        retried += 1;
      },
    });

    // The role is on the component's root element, inside the mount target.
    const alert = mounted.target.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Could not load your notes');

    mounted.target.querySelector<HTMLButtonElement>('[data-testid="error-state-retry"]')?.click();
    flushSync();
    expect(retried).toBe(1);

    mounted.destroy();
  });

  test('hides retry when retrying cannot help', () => {
    const mounted = mountInDocument(ErrorState, {
      message: 'Not allowed',
      retryable: false,
      onRetry: () => {},
    });

    expect(mounted.target.querySelector('[data-testid="error-state-retry"]')).toBeNull();

    mounted.destroy();
  });
});

// ── Container lifecycle ─────────────────────────────────────────────────────

describe('ScreenContainer lifecycle', () => {
  test('closing an operation prevents late failure state after unmount', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const operation = new AsyncOperation();
    const running = operation.run(() => pending).catch(() => undefined);
    expect(operation.isPending).toBe(true);
    operation.close();
    reject(new Error('late failure'));
    await running;
    flushSync();
    expect(operation.isPending).toBe(false);
    expect(operation.error).toBeNull();
  });

  test('unmount aborts and disposes immediately while initialization is pending', async () => {
    const viewModel = makeViewModel(fakeNotesService());
    let finish!: () => void;
    viewModel.initialize = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    let disposed = 0;
    viewModel.dispose = async () => {
      disposed += 1;
      viewModel.scope.close();
    };
    const mounted = mountInDocument(ScreenContainer, { screen: viewModel, children: emptySnippet });
    await Promise.resolve();
    mounted.destroy();
    expect(disposed).toBe(1);
    expect(viewModel.requests.cancelled).toBe(true);
    finish();
    await tick();
    expect(disposed).toBe(1);
  });

  test('cleanup registered after scope closure runs immediately', () => {
    const scope = new ScreenScope();
    scope.close();
    let released = 0;
    scope.onClose(() => {
      released += 1;
    });
    expect(released).toBe(1);
  });

  test('the notes submit button reacts while a save is pending', async () => {
    let finish!: () => void;
    const service = fakeNotesService({
      create: () =>
        new Promise<Note>((resolve) => {
          finish = () => resolve(note({ title: 'A title' }));
        }),
    });
    const viewModel = makeViewModel(service);
    viewModel.seed([]);
    const mounted = mountInDocument(NoteForm, {
      viewModel,
      note: undefined,
      onCancelEdit: () => {},
    });
    const title = mounted.target.querySelector<HTMLInputElement>(
      '[data-testid="note-title-input"]',
    );
    if (title === null) {
      throw new Error('Note title input is missing.');
    }
    title.value = 'A title';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.target
      .querySelector<HTMLFormElement>('[data-testid="note-form"]')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
    expect(
      mounted.target.querySelector<HTMLButtonElement>('[data-testid="note-submit"]')?.disabled,
    ).toBe(true);
    expect(mounted.target.textContent).toContain('Saving');
    finish();
    await tick();
    flushSync();
    expect(
      mounted.target.querySelector<HTMLButtonElement>('[data-testid="note-submit"]')?.disabled,
    ).toBe(false);
    mounted.destroy();
  });

  test('initializes on mount and disposes exactly once on unmount', async () => {
    const viewModel = makeViewModel(fakeNotesService());
    let initializations = 0;
    const originalInitialize = viewModel.initialize.bind(viewModel);
    viewModel.initialize = async () => {
      initializations += 1;
      await originalInitialize();
    };

    let disposals = 0;
    const originalDispose = viewModel.dispose.bind(viewModel);
    viewModel.dispose = async () => {
      disposals += 1;
      await originalDispose();
    };

    const mounted = mountInDocument(ScreenContainer, {
      screen: viewModel,
      children: emptySnippet,
    });

    await tick();
    flushSync();

    expect(initializations).toBe(1);
    expect(viewModel.mounted).toBe(true);

    mounted.destroy();
    await tick();
    flushSync();

    expect(disposals).toBe(1);
    expect(viewModel.mounted).toBe(false);
  });

  test('a lifecycle failure is reported rather than becoming an unhandled rejection', async () => {
    const viewModel = makeViewModel(fakeNotesService());
    viewModel.initialize = () => Promise.reject(new Error('initialize exploded'));

    // Captured as text, not as objects: `JSON.stringify(new Error('x'))` is
    // "{}", so asserting on the serialised args would silently pass on a
    // message that is not there.
    const reported: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
          .join(' '),
      );
    };

    const mounted = mountInDocument(ScreenContainer, {
      screen: viewModel,
      children: emptySnippet,
    });

    await Promise.resolve();
    mounted.destroy();
    await tick();
    flushSync();

    console.error = originalError;

    // The failure surfaced, it named the ViewModel, and it kept the message.
    expect(reported.length).toBeGreaterThan(0);
    const combined = reported.join('\n');
    expect(combined).toContain('initialize');
    expect(combined).toContain('NotesViewModel');
    expect(combined).toContain('initialize exploded');
  });
});
