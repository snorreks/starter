// packages/shared/utils/src/lib/common/listener.ts
//
// A minimal observable primitive. Chosen over a global event bus so that a
// ViewModel's subscriptions are owned by that ViewModel and released in its
// `dispose()` — the alternative (module-level singletons) is how stale state
// outlives the screen that produced it.

export type Listener<T> = (payload: T) => void;
export type UnsubscribeFunction = () => void;

export type Observer<T> = {
  subscribe(listener: Listener<T>): UnsubscribeFunction;
  publish(payload: T): void;
};

export type LiteObserver<T> = {
  subscribe(listener: Listener<T>): void;
  publish(payload: T): void;
};

/** Multi-subscriber observer. */
export const createObserver = <T = void>(): Observer<T> => {
  const listeners = new Set<Listener<T>>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(payload) {
      // Copy before iterating: a listener may unsubscribe during dispatch.
      for (const listener of [...listeners]) {
        listener(payload);
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
