// packages/shared/utils/src/lib/common/base_class.ts
//
// The one base class for anything with a lifecycle.
//
// Why `BaseClass.create()` and not `new`: a single canonical construction path.
// It gives every instance a name for logging, applies dev-only method tracing,
// and keeps the "you must go through the factory" rule enforceable rather than
// conventional.

import type { LogEntry, LogLevel } from '@starter/schemas/logging';
import { logger } from '#logger';
import {
  createLiteObserver,
  createObserver,
  type Listener,
  type UnsubscribeFunction,
} from './listener.ts';

export interface BaseClassOptions {
  /**
   * Display name, used as the log prefix and as the test id. Required so that
   * every instance is identifiable in a log without stack inspection.
   */
  className: string;
  /**
   * Dev-only method tracing. Defaults to on in development, off in production.
   *
   * Enabled by default because it is how a maintainer answers "who called this
   * and with what" without adding a log line to every method.
   */
  enableAutoDebug?: boolean;
  /** Method names to exclude from tracing (high-frequency call sites). */
  excludeAutoDebugMethods?: readonly string[];
}

export interface BaseClassInterface {
  readonly className: string;
  dispose(): Promise<void>;
}

/** Never traced: logging itself, plus the lifecycle hooks. */
const NEVER_TRACED_METHODS = new Set([
  'debug',
  'info',
  'warn',
  'error',
  'log',
  'spam',
  'writeLog',
  'dispose',
  'createObserver',
  'createLiteObserver',
  'constructor',
]);

export abstract class BaseClass<Options extends BaseClassOptions = BaseClassOptions>
  implements BaseClassInterface
{
  private static get _logger() {
    return logger;
  }

  static setLogLevel(level: LogLevel): void {
    BaseClass._logger.setLogLevel(level);
  }

  /**
   * Environment detection that works in Vite, Bun and Node without a build-time
   * constant, because a base class cannot import a framework's env module.
   */
  static isDevelopmentMode(): boolean {
    const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> | undefined }).env;
    if (metaEnv && typeof metaEnv === 'object' && 'DEV' in metaEnv) {
      return String(metaEnv.DEV) === 'true';
    }

    if (typeof process !== 'undefined' && process.env) {
      return process.env.NODE_ENV !== 'production';
    }

    return false;
  }

  /**
   * The canonical constructor.
   *
   * In development it shadows prototype methods on the *instance* to trace
   * calls. It deliberately does not use a `Proxy`: Svelte 5 `$state` and
   * native `#private` fields both break when a proxy sits in front of them, and
   * the instance is handed straight to a reactive graph. Shadowing produces a
   * pristine object that Svelte proxies itself, correctly.
   */
  static create<O extends BaseClassOptions, T extends BaseClass<O>>(
    this: new (
      options: O,
    ) => T,
    options: O,
  ): T {
    const instance = new this(options);

    if (!(options.enableAutoDebug ?? BaseClass.isDevelopmentMode())) {
      return instance;
    }

    let proto: object | null = Object.getPrototypeOf(instance);

    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);

        if (
          !descriptor ||
          typeof descriptor.value !== 'function' ||
          NEVER_TRACED_METHODS.has(key) ||
          key.startsWith('_') ||
          options.excludeAutoDebugMethods?.includes(key) ||
          Object.hasOwn(instance, key)
        ) {
          continue;
        }

        const original = descriptor.value as (this: T, ...args: unknown[]) => unknown;

        Object.defineProperty(instance, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          value(this: T, ...args: unknown[]) {
            // Deduped: these call sites are chosen precisely because they are hot.
            BaseClass._logger.spam(`${options.className}.${key}`, ...args);
            return original.apply(this, args);
          },
        });
      }

      proto = Object.getPrototypeOf(proto) as object | null;
    }

    return instance;
  }

  /**
   * Declared and assigned, never a constructor parameter property.
   *
   * Node 22 strips types without transforming them, and a parameter property is
   * a transform — `constructor(protected readonly options: Options)` is a 500 on
   * every request under `vite dev`, and no amount of correct TypeScript gets past
   * it. The field plus the assignment is the same semantics in syntax that both
   * strip-only Node and a bundler accept, so this package stays loadable in the
   * one runtime that cannot rewrite it.
   */
  protected readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  get className(): string {
    return this.options.className;
  }

  async dispose(): Promise<void> {
    this.debug('dispose');
    await Promise.resolve();
  }

  protected debug(...args: unknown[]): void {
    this.writeLog({ logLevel: 'DEBUG', logType: 'debug' }, ...args);
  }

  protected info(...args: unknown[]): void {
    this.writeLog({ logLevel: 'INFO', logType: 'info' }, ...args);
  }

  protected warn(...args: unknown[]): void {
    this.writeLog({ logLevel: 'WARNING', logType: 'warn' }, ...args);
  }

  protected error(...args: unknown[]): void {
    this.writeLog({ logLevel: 'ERROR', logType: 'error' }, ...args);
  }

  protected log(...args: unknown[]): void {
    this.writeLog({ logLevel: 'INFO', logType: 'log' }, ...args);
  }

  /**
   * Content-deduplicated debug logging. The right tool for a call site that
   * repeats every frame or every keystroke; a heartbeat is emitted while a
   * message stays suppressed so a stall is still visible.
   */
  protected spam(id: string, ...args: unknown[]): void {
    BaseClass._logger.spam(id, ...args);
  }

  /** Forward a pre-built entry (e.g. carrying a trace id) to the logger. */
  protected writeLog(entry: LogEntry, ...data: unknown[]): void {
    const timestamp = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    let message = `${timestamp} [${this.options.className}] `;

    if (entry.message) {
      message += entry.message;
    } else if (typeof data[0] === 'string') {
      message += data.shift() as string;
    }

    BaseClass._logger.write({ ...entry, message }, ...data);
  }

  protected createObserver<Event = void>(): {
    subscribe: (listener: Listener<Event>) => UnsubscribeFunction;
    publish: (event: Event) => void;
  } {
    return createObserver<Event>();
  }

  protected createLiteObserver<Event = void>(): {
    subscribe: (listener: Listener<Event>) => void;
    publish: (event: Event) => void;
  } {
    return createLiteObserver<Event>();
  }
}
