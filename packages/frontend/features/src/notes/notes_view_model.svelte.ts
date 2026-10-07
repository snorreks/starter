// apps/frontend/client/src/lib/features/notes/notes_view_model.svelte.ts
//
// The notes screen's state and commands.
//
// Composition, not inheritance
// ---------------------------
// This class used to extend `BaseViewModel` from a package called
// `@starter/frontend-services`. What it actually used was two objects it now holds
// directly — `StaleGuard` for loads and `MutationGuard` for writes — plus a
// `dispose` that put them away in a fixed order. Those are the three rules that
// prevent the bugs worth preventing, and they live in `@starter/utils` as plain
// objects with no dependency on Svelte or on any base class.
//
// Nothing was lost and the chain is three classes shorter. What was lost is the
// ability to be a `BaseViewModel` without being this screen, which nothing wanted.
//
// One status, not four booleans
// -----------------------------
// With independent `isLoading` / `isEmpty` / `error` flags there are eight
// representable combinations and only three of them are legal. Modelling the
// status as a union makes the illegal states unrepresentable, and it means a new
// status is a compile error in exactly one place: the view's `{#if}` chain.
//
// The list lives *inside* `status`. A parallel `notes` array would need its own
// consistency rules; here there is one value and it is the list the view renders.

import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import { reportError } from '@starter/ui';
import { AsyncOperation } from '@starter/ui/async_operation.svelte';
import {
  disposeScreen,
  type ScreenGuards,
  type ScreenOwner,
  ScreenScope,
} from '@starter/ui/screen';
import { OptimisticUpdate, toAppError } from '@starter/utils';

export interface NotesScreenService {
  list(signal?: AbortSignal): Promise<Note[]>;
  create(input: NoteCreate, signal?: AbortSignal): Promise<Note>;
  update(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<Note>;
  remove(id: string, signal?: AbortSignal): Promise<void>;
}

export type NotesStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; notes: Note[] }
  | { kind: 'error'; message: string; retryable: boolean };

export interface NotesScreenOptions {
  notes: NotesScreenService;
  /** The list the server already rendered, so the first paint is not empty. */
  initialNotes?: readonly Note[];
}

export class NotesViewModel implements ScreenOwner, ScreenGuards {
  readonly className = 'NotesViewModel';

  /**
   * Exposed so `ScreenContainer` and the free lifecycle functions can reach them.
   *
   * Read-only in practice: `disposeScreen` and `runScreenWrite` accept them as a
   * `ScreenGuards`, and nothing outside this file passes them anywhere.
   */
  readonly scope = new ScreenScope();
  get requests() {
    return this.scope.requests;
  }
  get mutations() {
    return this.scope.mutations;
  }

  status = $state<NotesStatus>({ kind: 'loading' });
  readonly operation = new AsyncOperation();
  mutationError = $state<string | null>(null);
  /** Id being edited, or null when the composer is creating. */
  editingId = $state<string | null>(null);

  /** Claimed by `ScreenContainer`; never written from here. */
  mounted = false;

  readonly #notes: NotesScreenService;
  readonly #optimistic = new OptimisticUpdate<Note>();

  /**
   * Whether the server already produced this list.
   *
   * Without it, `initialize()` cannot tell "the server rendered this" from
   * "nothing has happened yet", so the first browser fetch would duplicate work
   * the SSR load had already done — the same data over the wire twice on every
   * page view, and a visible flash while the second answer arrives.
   */
  #seeded = false;

  constructor(options: NotesScreenOptions) {
    this.#notes = options.notes;
    if (options.initialNotes !== undefined) {
      this.seed(options.initialNotes);
    }
  }

  get notes(): Note[] {
    return this.status.kind === 'ready' ? this.status.notes : [];
  }

  get isEmpty(): boolean {
    return this.status.kind === 'ready' && this.status.notes.length === 0;
  }

  get noteBeingEdited(): Note | undefined {
    const id = this.editingId;
    return id === null ? undefined : this.notes.find((note) => note.id === id);
  }

  /** True while at least one write is in the air. Two deletes is still true. */
  get isMutating(): boolean {
    return this.operation.isPending;
  }

  /** Replace the list with one the server already sent. */
  seed(notes: readonly Note[]): void {
    // Any outstanding rollback is now stale: the server's list is authoritative,
    // so a pending optimistic delete must not resurrect a row it just removed.
    this.#optimistic.supersede();
    this.requests.invalidate();
    this.status = { kind: 'ready', notes: sortByRecency(notes) };
    this.#seeded = true;
  }

  async initialize(): Promise<void> {
    if (this.#seeded) {
      return;
    }
    await this.load();
  }

  /**
   * Fetch the list, discarding the answer if a newer fetch started.
   *
   * The guard, not a comparison of ids, is what makes this correct: two loads can
   * resolve in either order, and only the newest is allowed to write.
   */
  async load(): Promise<void> {
    if (this.requests.cancelled) {
      return;
    }

    const { token, signal } = this.requests.begin();
    this.status = { kind: 'loading' };
    this.#optimistic.supersede();

    try {
      const notes = await this.#notes.list(signal);
      // After awaiting. A superseded or torn-down screen must not be written to.
      if (!this.requests.isCurrent(token)) {
        return;
      }
      this.#seeded = true;
      this.status = { kind: 'ready', notes: sortByRecency(notes) };
    } catch (error) {
      if (!this.requests.isCurrent(token)) {
        return;
      }
      const appError = toAppError(error, 'Could not load your notes.');
      if (appError.errorType === 'aborted') {
        return;
      }
      this.status = {
        kind: 'error',
        message: appError.message,
        // A 403 will not become a 401 by trying again, and offering a retry that
        // cannot succeed is how a permission problem gets reported as a flaky one.
        retryable: appError.errorType !== 'forbidden' && appError.errorType !== 'unauthorized',
      };
      reportError(appError);
    }
  }

  startEditing(id: string | null): void {
    this.editingId = id;
  }

  async createNote(input: NoteCreate): Promise<boolean> {
    const created = await this.#mutate(
      (signal) => this.#notes.create(input, signal),
      'Could not save the note.',
    );
    if (created) {
      await this.load();
    }
    return created;
  }

  async updateNote(id: string, input: NoteUpdate): Promise<boolean> {
    const updated = await this.#mutate(
      (signal) => this.#notes.update(id, input, signal),
      'Could not update the note.',
    );
    if (updated) {
      await this.load();
    }
    return updated;
  }

  /**
   * Delete optimistically, then reconcile.
   *
   * The row disappears immediately because the user's intent is unambiguous and a
   * confirmed-but-instant delete reads as a broken screen. Three things follow
   * from that, and each is a real bug the simpler version had:
   *
   *   - the receipt rolls back against the *latest* list, not the snapshot it
   *     captured. Two overlapping deletes each hold a snapshot; the loser's
   *     rollback would restore the winner's already-deleted row.
   *   - a disposed screen does not roll back, because there is nothing left to
   *     roll back into.
   *   - **an abort is not proof the server did not delete the note.** The request
   *     may have been committed before the connection dropped. So an abort does
   *     not roll back and does not retry: it reloads, which is the only way to
   *     find out. Reissuing the delete would be a second write against a row that
   *     may already be gone.
   */
  async deleteNote(id: string): Promise<boolean> {
    if (this.status.kind !== 'ready') {
      return false;
    }

    const { list, receipt } = this.#optimistic.apply(this.status.notes, [id]);
    this.status = { kind: 'ready', notes: list };
    this.mutationError = null;

    const handle = this.mutations.begin();
    if (handle === null) {
      this.status = { kind: 'ready', notes: receipt.rollback(list) };
      return false;
    }
    this.mutationError = null;

    try {
      await this.operation.run(() => this.#notes.remove(id, handle.signal));
      receipt.commit();
      if (this.requests.cancelled) {
        return false;
      }
      if (this.editingId === id) {
        this.editingId = null;
      }
      return true;
    } catch (error) {
      const appError = toAppError(error, 'Could not delete the note.');
      if (!this.mutations.disposed) {
        this.mutationError = appError.errorType === 'aborted' ? null : appError.message;
      }

      // A **definite** failure is a definite answer: the server refused, and the
      // row is still there. Roll it back and say so.
      //
      // An **abort** is not. The request may have been committed before the
      // connection dropped, so rolling back would show the user a note that is
      // already gone, and — worse — invite them to press delete again. There is no
      // local fix for "unknown", only asking the server. So this reloads rather than
      // retrying: a second DELETE against a row that did delete is a second write,
      // and the prompt for this screen is reconcile, never reissue.
      if (appError.errorType === 'aborted') {
        reportError(appError);
        await this.load();
        return false;
      }

      if (!this.requests.cancelled && this.status.kind === 'ready') {
        this.status = { kind: 'ready', notes: receipt.rollback(this.status.notes) };
      }
      reportError(appError);
      return false;
    } finally {
      this.mutations.end();
    }
  }

  async dispose(): Promise<void> {
    this.operation.close();
    disposeScreen(this);
  }

  /**
   * One write, with the accounting that is easy to get wrong.
   *
   * A `finally` that clears a boolean when the *first* of two in-flight writes
   * finishes is the bug `MutationGuard`'s counter exists to prevent, so the
   * counting is not repeated at each call site.
   */
  async #mutate(
    write: (signal: AbortSignal) => Promise<unknown>,
    failureMessage: string,
  ): Promise<boolean> {
    if (this.mutations.disposed) {
      return false;
    }
    const handle = this.mutations.begin();
    if (handle === null) {
      return false;
    }
    this.mutationError = null;
    try {
      await this.operation.run(() => write(handle.signal));
      return !this.mutations.disposed;
    } catch (error) {
      const appError = toAppError(error, failureMessage);
      if (!this.mutations.disposed) {
        this.mutationError = appError.message;
      }
      reportError(appError);
      return false;
    } finally {
      this.mutations.end();
    }
  }
}

/**
 * Newest first.
 *
 * A function rather than an inline sort because it runs in both `seed` and `load`,
 * and two copies of a comparator are two copies to keep in step.
 */
const sortByRecency = (notes: readonly Note[]): Note[] =>
  [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
