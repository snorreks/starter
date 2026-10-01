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
import { OptimisticUpdate, toAppError } from '@starter/utils';
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
  /**
   * The list the server already rendered, if any.
   *
   * The SSR load returns the owner's notes, so the first paint has data and
   * `initialize()` has nothing left to fetch. Without this the screen shows a
   * loading state, issues the identical request, and renders the same list — a
   * visible flash and a wasted round trip on every visit.
   */
  initialNotes?: Note[];
}

export class NotesViewModel extends BaseViewModel<{
  className: string;
  startWithLoadingView?: boolean;
}> {
  readonly #notes: NotesService;
  /**
   * True once the screen has data from somewhere — a seed, or a completed load.
   *
   * This is what makes "already loaded" a fact rather than a guess. Without it,
   * `initialize()` cannot tell "the server rendered this list" from "nothing has
   * happened yet", and the only two remaining options are always refetching (a
   * flash on every visit) or never loading at all (a permanently empty screen when
   * the first render had no data).
   */
  #seeded = false;

  status = $state<NotesStatus>({ kind: 'loading' });
  /** Id being edited, or null when the composer is creating. */
  editingId = $state<string | null>(null);

  /**
   * Ownership of optimistic list changes.
   *
   * One instance for the screen rather than one per delete, because a rollback
   * has to be able to see that *another* delete already wrote the list. With a
   * plain snapshot per call, two overlapping deletes each captured the list as it
   * was before they started, so the loser's rollback put the winner's deleted row
   * back. See `OptimisticUpdate`.
   */
  readonly #optimistic = new OptimisticUpdate<Note>();

  constructor(options: NotesViewModelOptions = {}) {
    super({
      className: options.className ?? 'NotesViewModel',
      startWithLoadingView: false,
    });
    this.#notes = options.notes ?? notesService;
    if (options.initialNotes !== undefined) {
      this.seed(options.initialNotes);
    }
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

  /**
   * Adopt a list the server already produced.
   *
   * Sorts exactly as `load()` does, so seeding and loading cannot produce two
   * different orders for the same data. Deliberately *not* a load: there is no
   * request, so there is nothing to abort and nothing that can fail. Any
   * outstanding optimistic rollback is superseded for the same reason `load()`
   * supersedes it — its snapshot no longer describes the list on screen.
   */
  seed(notes: readonly Note[]): void {
    this.#optimistic.supersede();
    this.status = { kind: 'ready', notes: [...notes].sort((a, b) => b.updatedAt - a.updatedAt) };
    this.#seeded = true;
  }

  override async initialize(): Promise<void> {
    if (this.#seeded) {
      return;
    }
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
    if (this._disposed) {
      // A released ViewModel must not start new work. `cancelAll` covers an
      // in-flight load; this covers one that has not begun.
      return;
    }

    const { token, signal } = this._requests.begin();
    this.status = { kind: 'loading' };

    // A load replaces the list from the server, so any outstanding optimistic
    // rollback is now stale: it would compare against its own snapshot and put
    // back a row this load has already removed.
    this.#optimistic.supersede();

    try {
      const notes = await this.#notes.list(signal);

      if (!this._requests.isCurrent(token)) {
        return;
      }

      this.#seeded = true;
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
    return this.#mutate(() => this.#notes.create(input));
  }

  async updateNote(id: string, input: NoteUpdate): Promise<boolean> {
    return this.#mutate(() => this.#notes.update(id, input));
  }

  /**
   * Delete a note.
   *
   * Removal is local-first so the list responds immediately, and the row is
   * restored if the server rejects it. The alternative — waiting for the round
   * trip — makes the UI feel broken on a slow connection, and a silent failure
   * leaves the user believing a note is gone when it is not.
   *
   * The rollback goes through `OptimisticUpdate`, so it reinserts *this* delete's
   * row and yields to any other write that landed in the meantime. A snapshot
   * restored unconditionally resurrects a row a concurrent delete already removed.
   */
  async deleteNote(id: string): Promise<boolean> {
    if (this.status.kind !== 'ready') {
      // Nothing rendered to delete from. Refusing is right; inventing a list here
      // would put a row back that the user never saw.
      return false;
    }

    const { list, receipt } = this.#optimistic.apply(this.status.notes, [id]);
    this.status = { kind: 'ready', notes: list };

    const handle = this._mutations.begin();
    if (handle === null) {
      // Disposed between the check above and here. Undo the optimistic removal so
      // the released ViewModel is not left showing a row it never deleted.
      this.status = { kind: 'ready', notes: receipt.rollback(list) };
      return false;
    }

    try {
      await this.#notes.remove(id);
      receipt.commit();

      if (this._disposed) {
        return false;
      }

      if (this.editingId === id) {
        this.editingId = null;
      }
      return true;
    } catch (error) {
      if (!this._disposed && this.status.kind === 'ready') {
        this.status = { kind: 'ready', notes: receipt.rollback(this.status.notes) };
      }
      this.showErrorNotification(error, 'Could not delete the note.');
      return false;
    } finally {
      this._mutations.end();
    }
  }

  startEditing(id: string): void {
    this.editingId = id;
  }

  stopEditing(): void {
    this.editingId = null;
  }

  /**
   * Run a write, then refresh from the server.
   *
   * The refresh is the point: after any write the server is the authority on
   * what exists. Patching local state instead would let a rejected write, a
   * concurrent edit, or a server-normalised field go unnoticed.
   *
   * Lifecycle is the base class's job — `_runMutation` refuses once disposed and
   * owns the in-flight count, so this method has no `finally` of its own to get
   * wrong.
   */
  async #mutate(action: () => Promise<unknown>): Promise<boolean> {
    const written = await this._runMutation(action);

    if (!written) {
      return false;
    }

    // A disposal during the write must not trigger a fresh load on a released
    // ViewModel; `load` would refuse anyway, but the guard is explicit here
    // because the intent is different from "the write failed".
    if (this._disposed) {
      return false;
    }

    await this.load();
    return !this._disposed;
  }
}

export const createNotesViewModel = (options: NotesViewModelOptions = {}): NotesViewModel =>
  NotesViewModel.create({ ...options, className: options.className ?? 'NotesViewModel' });
