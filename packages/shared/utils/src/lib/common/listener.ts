// packages/shared/utils/src/lib/common/listener.ts
//
// A minimal observable primitive. Chosen over a global event bus so that a
// ViewModel's subscriptions are owned by that ViewModel and released in its
// `dispose()` — the alternative (module-level singletons) is how stale state
// outlives the screen that produced it.

export type Listener<T> = (payload: T) => void;
export type UnsubscribeFunction = () => void;

export interface Observer<T> {
  subscribe(listener: Listener<T>): UnsubscribeFunction;
  publish(payload: T): void;
}

export interface LiteObserver<T> {
  subscribe(listener: Listener<T>): void;
  publish(payload: T): void;
}

/**
 * Multi-subscriber observer.
 *
 * Subscribers are held in an array rather than a `Set`, for two reasons that
 * both showed up as bugs in the project this came from:
 *
 *   - A `Set` silently dedupes. Registering the same function from two call
 *     sites would leave one of them never firing, with no error anywhere.
 *   - A `Set` deletes by identity, so two registrations of one function cannot
 *     be unsubscribed independently: the first unsubscribe kills both.
 *
 * The unsubscribe returned closes over the *registration*, not the function, so
 * it removes exactly the subscription it came from.
 *
 * Dispatch is deliberately *not* fail-fast. A listener that throws does not stop
 * the ones after it, because propagating is strictly worse: one
 * permanently-broken subscriber then starves every later subscriber on every
 * subsequent publish, so the symptom is "the second panel stopped updating" with
 * no error anywhere to explain it. Isolating the throw leaves the faulty listener
 * broken — but visibly so, and only for itself.
 */
export const createObserver = <T = void>(): Observer<T> => {
  const listeners: Listener<T>[] = [];

  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    publish(payload) {
      // Copy before iterating: a listener may unsubscribe during dispatch, and
      // splicing the live array mid-iteration would skip the next one.
      for (const listener of [...listeners]) {
        try {
          listener(payload);
        } catch {
          // Isolated on purpose; see the note above.
        }
      }
    },
  };
};

/** Single-subscriber observer; a new `subscribe` replaces the previous one. */
export const createLiteObserver = <T = void>(): LiteObserver<T> => {
  let listener: Listener<T> | undefined;

  return {
    subscribe(next) {
      listener = next;
    },
    publish(payload) {
      listener?.(payload);
    },
  };
};
