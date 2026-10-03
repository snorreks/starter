// packages/shared/logger/src/lib/base.ts
//
// The logger core: level filtering, content-deduplicated `spam()`, loop
// protection and sink dispatch. Concrete loggers (console / browser / worker)
// subclass this and implement `write`.
//
// Two properties this file is responsible for:
//   1. Sinks can never break logging. A throwing sink is swallowed, because the
//      alternative is a logging failure masking the error being logged.
//   2. A runaway call site is throttled, not amplified.

import {
  isLogLevel,
  type LogEntry,
  type LoggerInterface,
  type LogLevel,
  LogLevelIndex,
  LogLevelPriority,
  type LogSink,
  type TimerInterface,
} from '@starter/schemas/logging';
import { Timer } from './timer.ts';

interface SpamEntry {
  lastContent: string;
  lastEmitted: number;
  suppressed: number;
  suppressedSince: number;
  lastAccess: number;
}

/** Minimum interval between emissions of the same spam id (ms). */
const SPAM_THROTTLE_MS = 500;
/** Heartbeat cadence while a message stays suppressed (ms). */
const SPAM_HEARTBEAT_MS = 10_000;
/** Spam entries untouched for this long are dropped (ms). */
const SPAM_ENTRY_TTL_MS = 60_000;
/** Identical signature within this window counts as a repeat. */
const REPEAT_WINDOW_MS = 50;
/** Repeats before the throttle engages. */
const REPEAT_LIMIT = 100;

export abstract class BaseLoggerService implements LoggerInterface {
  logLevel: LogLevel;
  protected sinks: LogSink[] = [];

  #spam = new Map<string, SpamEntry>();
  #lastSpamSweep = 0;

  #lastSignature = '';
  #repeatCount = 0;
  #lastSignatureAt = 0;
  #throttleAnnounced = false;

  constructor(options?: { logLevel?: LogLevel | string }) {
    const requested = options?.logLevel?.toUpperCase();
    this.logLevel = isLogLevel(requested) ? requested : 'INFO';
  }

  setLogLevel(logLevel: LogLevel): void {
    if (!isLogLevel(logLevel)) {
      this.warn(`Ignoring invalid log level "${String(logLevel)}".`);
      return;
    }
    this.logLevel = logLevel;
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  abstract write(entry: LogEntry, ...data: unknown[]): void;

  log(...args: unknown[]): void {
    this.write({ logLevel: 'INFO', logType: 'log' }, ...args);
  }

  debug(...args: unknown[]): void {
    this.write({ logLevel: 'DEBUG', logType: 'debug' }, ...args);
  }

  info(...args: unknown[]): void {
    this.write({ logLevel: 'INFO', logType: 'info' }, ...args);
  }

  warn(...args: unknown[]): void {
    this.write({ logLevel: 'WARNING', logType: 'warn' }, ...args);
  }

  error(...args: unknown[]): void {
    this.write({ logLevel: 'ERROR', logType: 'error' }, ...args);
  }

  /**
   * Emit unless the same id has just emitted the same content. While a message
   * is suppressed a heartbeat keeps the silence visible, so a throttled stall
   * never looks identical to an idle loop.
   */
  spam(id: string, ...args: unknown[]): void {
    const content = args
      .map((arg) => {
        if (typeof arg === 'string') {
          return arg;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return `[${typeof arg}]`;
        }
      })
      .join(' ');

    const now = Date.now();
    this.#sweepSpam(now);

    const state = this.#spam.get(id);

    if (!state) {
      this.#spam.set(id, {
        lastContent: content,
        lastEmitted: now,
        suppressed: 0,
        suppressedSince: 0,
        lastAccess: now,
      });
      this.debug(...args);
      return;
    }

    state.lastAccess = now;

    if (state.lastContent === content) {
      state.suppressed += 1;
      if (state.suppressedSince === 0) {
        state.suppressedSince = now;
      }

      if (now - state.suppressedSince >= SPAM_HEARTBEAT_MS) {
        const seconds = ((now - state.suppressedSince) / 1000).toFixed(0);
        this.debug(`[spam:${id}] suppressed ${state.suppressed} repeats in ${seconds}s`);
        state.suppressed = 0;
        state.suppressedSince = now;
      }
      return;
    }

    if (now - state.lastEmitted < SPAM_THROTTLE_MS) {
      state.suppressed += 1;
      return;
    }

    if (state.suppressed > 0) {
      this.debug(`[spam:${id}] suppressed ${state.suppressed} repeats`);
    }

    state.lastContent = content;
    state.lastEmitted = now;
    state.suppressed = 0;
    state.suppressedSince = 0;
    this.debug(...args);
  }

  createTimer(): TimerInterface {
    return new Timer();
  }

  /**
   * Would this entry be emitted at the current level?
   *
   * Public because a sink has to know whether an event was suppressed before it
   * records it — otherwise a `MemoryLogSink` fills with events the console
   * never showed, and a test asserting on the ring asserts on fiction.
   *
   * The configured level is the *lowest severity that is emitted*, so the test is
   * whether the entry's severity reaches it.
   *
   * The comparison was `configured > entry`, which is backwards: with the default
   * `INFO` it suppressed everything except `DEBUG` — a deployed Worker at its
   * default level emitted only debug records, and dropped the `ERROR` it existed to
   * report. Nothing noticed, because the effect looked identical to "the code never
   * logged", which is the same conclusion the missing workerd sink produced. Both
   * had to be fixed before a record could be observed at all.
   */
  willLog(entry: LogEntry): boolean {
    if (this.logLevel === 'NONE') {
      // `NONE` is a real level meaning "emit nothing". It used to return `true`,
      // which let a sink record events a `NONE` logger was configured to discard.
      return false;
    }
    return (
      LogLevelPriority[LogLevelIndex[entry.logLevel]] >=
      LogLevelPriority[LogLevelIndex[this.logLevel]]
    );
  }

  /** Fan out to sinks. Never throws, so a bad sink cannot break a log call. */
  protected flushSinks(entry: LogEntry, ...data: unknown[]): void {
    if (this.#isRepeating(entry, data)) {
      return;
    }

    for (const sink of this.sinks) {
      try {
        void sink.write(entry, ...data);
      } catch {
        // A failing sink is not allowed to become the reported error.
      }
    }
  }

  #sweepSpam(now: number): void {
    if (now - this.#lastSpamSweep < SPAM_HEARTBEAT_MS) {
      return;
    }
    this.#lastSpamSweep = now;

    for (const [id, entry] of this.#spam) {
      if (now - entry.lastAccess > SPAM_ENTRY_TTL_MS) {
        this.#spam.delete(id);
      }
    }
  }

  /**
   * Throttle an identical signature fired pathologically fast. Development
   * only: in production volumes are sane and throttling would hide real data.
   */
  #isRepeating(entry: LogEntry, data: unknown[]): boolean {
    const isProduction =
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') ||
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, unknown> }).env !== undefined &&
        !(import.meta as unknown as { env: Record<string, unknown> }).env.DEV);

    if (isProduction) {
      return false;
    }

    const signature = entry.message ?? (typeof data[0] === 'string' ? data[0] : 'obj_log');
    const now = Date.now();

    if (this.#lastSignature === signature && now - this.#lastSignatureAt < REPEAT_WINDOW_MS) {
      this.#repeatCount += 1;

      if (this.#repeatCount > REPEAT_LIMIT) {
        if (!this.#throttleAnnounced) {
          this.#throttleAnnounced = true;
        }
        this.#lastSignatureAt = now;
        return true;
      }
    } else {
      this.#lastSignature = signature;
      this.#repeatCount = 1;
      this.#throttleAnnounced = false;
    }

    this.#lastSignatureAt = now;
    return false;
  }
}
