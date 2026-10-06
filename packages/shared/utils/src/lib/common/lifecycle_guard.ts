// packages/shared/utils/src/lib/common/lifecycle_guard.ts
//
// Two guards for asynchronous work that outlives a component's lifetime.
//
// They exist because the alternative was three bugs this starter had all shipped
// at once, and each was invisible in review because the code looks correct:
//
//   1. **A write that lands after disposal.** `StaleGuard.cancelAll()` stops a
//      *load* from writing, but a mutation that does not consult the guard still
//      assigns state on a ViewModel the container has already released.
//   2. **An optimistic rollback that clobbers a concurrent success.** A delete
//      removes a row locally and restores the previous list on failure. Two
//      overlapping deletes each captured a snapshot, so the loser's rollback
//      restored the winner's already-deleted row.
//   3. **A boolean that lies.** `isMutating = false` in a `finally` clears the
//      flag when the *first* of two in-flight mutations completes.
//
// `StaleGuard` handles (1) for loads and stays as it was — it is correct and
// tested. What it does not model is a write whose completion the caller needs a
// receipt for, so `MutationGuard` and `OptimisticUpdate` are the pieces for the
// write paths.
//
// Neither is an inheritance framework. Both are small objects a ViewModel holds.
// The audit's finding was that the lifecycle rules were implicit, not that there
// were too few helpers.

/**
 * Tracks in-flight mutations and whether the owner has been disposed.
 *
 * A counter rather than a boolean, deliberately: two overlapping deletes are two
 * operations, and a flag that clears when the first finishes reports "nothing is
 * happening" while the second is still in the air.
 */
export class MutationGuard {
  #inFlight = 0;
  #nextId = 0;
  #disposed = false;
  #controller: AbortController | undefined;

  /**
   * Begin a mutation, or `null` when the owner is disposed.
   *
   * `null` is the caller's signal to refuse the work rather than start it.
   * Refusing beats completing: a caller told "no" can handle it, while a caller
   * told "yes" after teardown is working on a released object.
   */
  begin(): MutationHandle | null {
    if (this.#disposed) {
      return null;
    }

    this.#inFlight += 1;
    return {
      id: ++this.#nextId,
      /** Aborted when the owner is disposed, for callers that can cancel. */
      signal: this.#disposeController().signal,
    };
  }

  /** Record one mutation finishing. Never goes below zero. */
  end(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
  }

  /**
   * Mark the owner disposed and abort in-flight work.
   *
   * Idempotent, because disposal is reachable from more than one path in a
   * component tree and throwing here would turn a benign double-unmount into a
   * teardown error.
   */
  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
  }

  #disposeController(): AbortController {
    this.#controller ??= new AbortController();
    return this.#controller;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** True while at least one mutation has neither ended nor been disposed. */
  get busy(): boolean {
    return this.#inFlight > 0;
  }
}

/** A begun mutation. Its presence is the caller's proof the work was allowed. */
export interface MutationHandle {
  /** Monotonic id, for correlating logs. */
  readonly id: number;
  /** Aborted when the owner is disposed. */
  readonly signal: AbortSignal;
}

/** What an optimistic change removed, and how to put it back. */
export interface OptimisticReceipt<Item extends { id: string }> {
  /** The items this operation removed. */
  readonly removed: readonly Item[];
  /**
   * Undo this removal against the *latest* list.
   *
   * Returns `latest` unchanged when the list has moved on since this operation
   * applied, because a newer change owns the list now. That is the whole point:
   * restoring unconditionally is what puts back a row a concurrent operation has
   * already deleted.
   */
  rollback(latest: readonly Item[]): Item[];
  /** Retire the receipt. A later `rollback` becomes a no-op. */
  commit(): void;
}

/**
 * An optimistic local change over a keyed list.
 *
 * One instance per screen, not one per operation: the rollback needs to see the
 * other operations' writes in order to know they happened.
 *
 * How staleness is decided: each operation records the exact list it produced.
 * A rollback reinserts its removed items only while the current list is still the
 * one it produced. If any other operation has written since — by applying here,
 * or by a plain assignment the caller makes — the current list differs and the
 * rollback yields.
 *
 * Comparing by identity of the resulting ids is what makes this work for a list
 * whose order also changes: a concurrent `load()` that re-sorts the same items is
 * a different list, and yielding to it is correct.
 */
export class OptimisticUpdate<Item extends { id: string }> {
  #receipt: { applied: readonly string[]; removed: readonly Item[] } | null = null;

  /**
   * Compute the optimistic list for removing `ids`, and record it.
   *
   * The caller assigns the result. It has to be the *same* array value returned
   * here, or assigned in the same state transition, for the staleness check to
   * hold — so this returns the list rather than only a predicate.
   */
  apply(
    current: readonly Item[],
    ids: readonly string[],
  ): {
    list: Item[];
    receipt: OptimisticReceipt<Item>;
  } {
    const removing = new Set(ids);
    const removed = current.filter((item) => removing.has(item.id));
    const list = current.filter((item) => !removing.has(item.id));
    const applied = list.map((item) => item.id);

    // Recorded *before* the caller assigns, because a second `apply` overwrites it
    // and the comparison in `rollback` is what tells the two apart. A receipt that
    // does not claim ownership can never roll back, which is the safe direction:
    // a missed rollback is visible, a wrong one is not.
    this.#receipt = { applied, removed };

    let settled = false;

    return {
      list,
      receipt: {
        removed,
        rollback: (latest: readonly Item[]): Item[] => {
          if (settled) {
            return [...latest];
          }

          // Another write owns the list. Yield: reinserting here would resurrect
          // whatever that write removed.
          if (this.#receipt?.applied !== applied) {
            return [...latest];
          }

          const present = new Set(latest.map((item) => item.id));
          return [...latest, ...removed.filter((item) => !present.has(item.id))];
        },
        commit: () => {
          settled = true;
          // Only clear the slot when it is still *this* receipt's. Two overlapping
          // deletes each hold a receipt, and `#receipt` names the newer one: the
          // first to succeed would otherwise retire the other's claim, and the
          // loser's rollback would then find `#receipt === null`, conclude the
          // list moved on, and yield — leaving a genuinely failed delete with no
          // row restored. Same key order, same claim; a different one is left
          // alone.
          if (this.#receipt?.applied === applied) {
            this.#receipt = null;
          }
        },
      },
    };
  }

  /**
   * Note that the list was replaced by something other than `apply`.
   *
   * A `load()` that lands while a delete is pending makes every outstanding
   * rollback stale. Without this the delete's rollback would compare against its
   * own snapshot and reinsert a row the load had already removed.
   */
  supersede(): void {
    this.#receipt = null;
  }
}
