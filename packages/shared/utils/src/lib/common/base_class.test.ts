// packages/shared/utils/src/lib/common/base_class.test.ts
//
// The one base class everything with a lifecycle extends.
//
// Two things here are load-bearing and easy to break silently:
//
//   1. `create()` shadows methods on the *instance*, not through a `Proxy`.
//      A Proxy in front of an instance breaks Svelte 5 `$state` and native `#`
//      fields, and the instance is handed straight to a reactive graph. A test
//      that only checks "does calling a method log?" passes under either
//      implementation; only a test that puts the instance in a `$state` box, or
//      that calls a `#private` method, tells them apart.
//
//   2. Shadowing must not clobber a method the subclass assigned in its own
//      constructor. Such a method is an own property, and `Object.hasOwn` is
//      what protects it.
//
// `BaseClass.create` also decides whether dev tracing is on at all, so the tests
// pin that decision rather than assuming the environment.

import { describe, expect, test } from 'bun:test';
import { BaseClass, type BaseClassOptions } from './base_class.ts';

/** A subclass with one ordinary method, one `#private` method, and a spy. */
class Widget extends BaseClass {
  calls: string[] = [];

  #secret = 7;

  greet(name: string): string {
    this.calls.push('greet');
    return `hello ${name}`;
  }

  revealSecret(): number {
    return this.#secret;
  }

  /** Assigned in the constructor, so it is an own property of the instance. */
  constructorOwn(): string {
    return 'own';
  }

  override dispose(): Promise<void> {
    this.calls.push('dispose');
    return Promise.resolve();
  }
}

/** A subclass whose constructor assigns a method onto `this`. */
class SelfAssigning extends BaseClass {
  later = (): string => 'assigned in constructor';
}

/**
 * A subclass whose constructor replaces a prototype method.
 *
 * TypeScript rejects assigning to a method, and the alternative — declaring it
 * as a property — would move it off the prototype, so this class does the
 * assignment through a widened view of `this`. That is what a real subclass in
 * this codebase does too, and it is exactly the case the guard protects.
 */
class OverridingWidget extends Widget {
  constructor(options: BaseClassOptions) {
    super(options);
    (this as unknown as Record<string, unknown>).greet = (): string => 'overridden';
  }
}

const options = (overrides: Partial<BaseClassOptions> = {}): BaseClassOptions => ({
  className: 'Widget',
  enableAutoDebug: false,
  ...overrides,
});

describe('BaseClass.create', () => {
  test('constructs a usable instance', () => {
    const widget = Widget.create(options());

    expect(widget).toBeInstanceOf(Widget);
    expect(widget.greet('world')).toBe('hello world');
  });

  test('exposes the class name it was constructed with', () => {
    // Every log line is prefixed with this, so a wrong name makes a log
    // unattributable.
    expect(Widget.create(options({ className: 'NotesViewModel' })).className).toBe(
      'NotesViewModel',
    );
  });

  test('does not use a Proxy, so native private fields still work', () => {
    // Under a Proxy, a `#private` read against a receiver that is not the
    // instance's own shape throws "Cannot read private member".
    const widget = Widget.create(options({ enableAutoDebug: true }));

    expect(widget.revealSecret()).toBe(7);
  });

  test('shadowing does not clobber a method assigned in the constructor', () => {
    // The bug this prevents: `create()` walks the prototype chain and would
    // overwrite an own property, silently discarding what the subclass set up.
    const instance = SelfAssigning.create(options({ enableAutoDebug: true }));

    expect(instance.later()).toBe('assigned in constructor');
  });

  test('preserves a prototype method a subclass overrode in its constructor', () => {
    const instance = OverridingWidget.create(options({ enableAutoDebug: true }));

    expect(instance.greet('world')).toBe('overridden');
  });

  test('inherited methods keep working under tracing', () => {
    class Child extends Widget {
      child(): string {
        return 'child';
      }
    }
    const instance = Child.create(options({ enableAutoDebug: true }));

    // The walk goes up the prototype chain, so a grandparent's method must be
    // shadowed rather than skipped.
    expect(instance.child()).toBe('child');
    expect(instance.greet('world')).toBe('hello world');
  });

  test('the shadowed method still receives its arguments and return value', () => {
    const widget = Widget.create(options({ enableAutoDebug: true }));

    expect(widget.greet('a')).toBe('hello a');
    expect(widget.calls).toEqual(['greet']);
  });

  test('does not trace an excluded method', () => {
    const widget = Widget.create(
      options({ enableAutoDebug: true, excludeAutoDebugMethods: ['greet'] }),
    );

    expect(widget.greet('x')).toBe('hello x');
    expect(Object.hasOwn(widget, 'greet')).toBe(false);
  });

  test('does not trace dispose, so teardown produces no log spam', () => {
    const widget = Widget.create(options({ enableAutoDebug: true }));

    expect(Object.hasOwn(widget, 'dispose')).toBe(false);
  });

  test('disabling auto-debug leaves the prototype untouched', () => {
    const widget = Widget.create(options({ enableAutoDebug: false }));

    expect(Object.hasOwn(widget, 'greet')).toBe(false);
  });

  test('logging methods are never shadowed, which would recurse', () => {
    const widget = Widget.create(options({ enableAutoDebug: true })) as unknown as Record<
      string,
      unknown
    >;

    for (const key of ['debug', 'info', 'warn', 'error', 'log', 'spam', 'writeLog']) {
      expect(Object.hasOwn(widget, key)).toBe(false);
    }
  });

  test('the instance is not frozen or sealed by shadowing', () => {
    const widget = Widget.create(options({ enableAutoDebug: true }));

    // Svelte's reactivity and the `$state` proxy both need to add properties.
    expect(Object.isExtensible(widget)).toBe(true);
  });

  test('dispose is awaitable and idempotent in shape', async () => {
    const widget = Widget.create(options());

    await widget.dispose();

    expect(widget.calls).toEqual(['dispose']);
  });
});

describe('BaseClass.isDevelopmentMode', () => {
  /**
   * Runs `body` with `NODE_ENV` set, restoring it afterwards.
   *
   * This is the only input a test can actually control. `import.meta.env` is
   * process-backed and read-only in Bun: assigning to it in the test file does
   * not change what another module reads, so the `import.meta.env.DEV` branch
   * cannot be exercised here — verified, not assumed. That branch is a build-time
   * substitution, so its real coverage is a production build; what is pinned
   * here is the `NODE_ENV` fallback and the fact that it is consulted at all.
   */
  const withNodeEnv = (value: string | undefined, body: () => void): void => {
    const previous = process.env.NODE_ENV;
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }
    try {
      body();
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  };

  test('reports production for NODE_ENV=production', () => {
    withNodeEnv('production', () => {
      expect(BaseClass.isDevelopmentMode()).toBe(false);
    });
  });

  test('reports development for NODE_ENV=development', () => {
    withNodeEnv('development', () => {
      expect(BaseClass.isDevelopmentMode()).toBe(true);
    });
  });

  test('treats an unset NODE_ENV as development', () => {
    // The safe default: a missing value must not silently disable the tracing
    // that makes a bug reproducible.
    withNodeEnv(undefined, () => {
      expect(BaseClass.isDevelopmentMode()).toBe(true);
    });
  });
});
