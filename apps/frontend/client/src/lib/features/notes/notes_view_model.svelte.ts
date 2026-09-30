// apps/frontend/client/src/lib/features/notes/notes_view_model.svelte.ts
//
// The reference ViewModel for this starter. Read this before adding a screen.
//
// It demonstrates, in one place, every rule the convention actually has:
//   - screen state as `$state`, derived state as `$derived`
//   - loading / empty / error / ready as ONE discriminated status, so the view
//     cannot render a contradictory combination
//   - requests via `StaleGuard`, so a slow earlier response cannot overwrite a
//     newer one
//   - `dispose()` aborts in-flight work and releases subscriptions
//   - no transport (that is `NotesService`), no business rules (pure functions),
//     and no domain state duplicated from the service
//
// What it deliberately does not do: expose `notes` as a second copy of state
// that something else also owns. The list here IS the list the view renders.

import { BaseViewModel } from '@starter/frontend-services/base';
import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import { toAppError } from '@starter/utils';
import { type NotesService, notesService } from './notes_service.svelte.ts';

/**
 * One status, not four booleans.
 *
 * With independent `isLoading` / `isEmpty` / `error` flags there are eight
 * representable combinations and only three of them are legal. Modelling the
 * status as a union makes the illegal states unrepresentable, and the view's
 * `{#if}` chain becomes exhaustive by construction.
 */
export type NotesStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; notes: Note[] }
  | { kind: 'error'; message: string; retryable: boolean };

export interface NotesViewModelOptions {
  className?: string;
  notes?: NotesService;
}

export class NotesViewModel extends BaseViewModel<{
  className: string;
  startWithLoadingView?: boolean;
}> {
  readonly #notes: NotesService;

  status = $state<NotesStatus>({ kind: 'loading' });
  /** Id being edited, or null when the composer is creating. */
  editingId = $state<string | null>(null);
  /** True while a create/update/delete round trip is in flight. */
  isMutating = $state(false);

  constructor(options: NotesViewModelOptions = {}) {
    super({
      className: options.className ?? 'NotesViewModel',
      startWithLoadingView: false,
    });
    this.#notes = options.notes ?? notesService;
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  get notes(): Note[] {
    return this.status.kind === 'ready' ? this.status.notes : [];
  }

  get isEmpty(): boolean {
    return this.status.kind === 'ready' && this.status.notes.length === 0;
  }

  get noteBeingEdited(): Note | undefined {
    return this.editingId === null
      ? undefined
      : this.notes.find((note) => note.id === this.editingId);
  }

  get isComposing(): boolean {
    return this.isMutating === false;
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  override async initialize(): Promise<void> {
    await this.load();
  }

  /**
   * Load the list.
   *
   * `StaleGuard` makes a repeated load safe by construction: the second call
   * aborts the first, and a response that still arrives is discarded by the
   * `isCurrent` check rather than overwriting fresher state.
   */
  async load(): Promise<void> {
    const { token, signal } = this._requests.begin();
    this.status = { kind: 'loading' };

    try {
      const notes = await this.#notes.list(signal);

      if (!this._requests.isCurrent(token)) {
        return;
      }

      // Newest first: the common case is "what did I just write".
      this.status = {
        kind: 'ready',
        notes: [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
      };
    } catch (error) {
      if (!this._requests.isCurrent(token)) {
        return;
      }

      const appError = toAppError(error, 'Could not load your notes.');

      if (appError.errorType === 'aborted') {
        // A superseded request is not a failure. Surfacing it would flash an
        // error on every keystroke-driven reload.
        return;
      }

      this.status = {
        kind: 'error',
        message: appError.message,
        // A 403/401 will not fix itself on retry; an outage might.
        retryable: appError.errorType !== 'forbidden' && appError.errorType !== 'unauthorized',
      };

      this.error('notes.load failed', appError);
    }
  }

  async createNote(input: NoteCreate): Promise<boolean> {
    return this.#mutate(() => this.#notes.create(input), 'Could not save the note.');
  }

  async updateNote(id: string, input: NoteUpdate): Promise<boolean> {
    return this.#mutate(() => this.#notes.update(id, input), 'Could not update the note.');
  }

  /**
   * Delete a note.
   *
   * Removal is local-first so the list responds immediately, and the previous
   * list is restored if the server rejects it. The alternative — waiting for the
   * round trip — makes the UI feel broken on a slow connection, and a silent
   * failure leaves the user believing a note is gone when it is not.
   */
  async deleteNote(id: string): Promise<boolean> {
    const previous = this.status.kind === 'ready' ? this.status.notes : [];
    const optimistic = previous.filter((note) => note.id !== id);

    if (this.status.kind === 'ready') {
      this.status = { kind: 'ready', notes: optimistic };
    }
    this.isMutating = true;

    try {
      await this.#notes.remove(id);
      if (this.editingId === id) {
        this.editingId = null;
      }
      return true;
    } catch (error) {
      if (this.status.kind === 'ready') {
        this.status = { kind: 'ready', notes: previous };
      }
      this.showErrorNotification(error, 'Could not delete the note.');
      return false;
    } finally {
      this.isMutating = false;
    }
  }

  startEditing(id: string): void {
    this.editingId = id;
  }

  stopEditing(): void {
    this.editingId = null;
  }

  /**
   * Run a mutation, then refresh from the server.
   *
   * The refresh is the point: after any write the server is the authority on
   * what exists. Patching local state instead would let a rejected write, a
   * concurrent edit, or a server-normalised field go unnoticed.
   */
  async #mutate(action: () => Promise<unknown>, failureMessage: string): Promise<boolean> {
    this.isMutating = true;
    try {
      await action();
      await this.load();
      return true;
    } catch (error) {
      this.showErrorNotification(error, failureMessage);
      return false;
    } finally {
      this.isMutating = false;
    }
  }
}

export const createNotesViewModel = (options: NotesViewModelOptions = {}): NotesViewModel =>
  NotesViewModel.create({ ...options, className: options.className ?? 'NotesViewModel' });
