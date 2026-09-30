// packages/shared/logger/src/lib/event_log.ts
//
// Turns a `LogEntry` plus runtime context into the canonical `LogEvent`.
//
// Context (app, environment, release, source) is supplied once at construction
// rather than passed per call: a call site that had to name its own environment
// would eventually name the wrong one, and a log that misreports its origin is
// worse than no log.

import type {
  DeploymentEnvironment,
  LogApp,
  LogEntry,
  LogEvent,
  LogSource,
} from '@starter/schemas/logging';
import { redactValue } from './redaction.ts';

export interface LogContext {
  app: LogApp;
  environment: DeploymentEnvironment;
  source: LogSource;
  /** Build id of this artifact. Injected at build time. */
  release: string;
  /** Extra field names to redact on top of the defaults. */
  extraRedactedKeys?: readonly string[];
}

/** Release identifier: the injected build id, or an explicit dev marker. */
export const resolveRelease = (injected?: string): string => {
  if (injected && injected.trim().length > 0) {
    return injected.trim();
  }
  return 'dev';
};

/** Normalize a `LogEntry` + context into the single structured event shape. */
export const toLogEvent = (entry: LogEntry, context: LogContext, ...data: unknown[]): LogEvent => {
  const messageParts: string[] = [];

  if (entry.message) {
    messageParts.push(entry.message);
  }

  for (const value of data) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      messageParts.push(value);
    } else {
      messageParts.push(
        JSON.stringify(redactValue(value, { extraKeys: context.extraRedactedKeys })),
      );
    }
  }

  const event: LogEvent = {
    timestamp: Date.now(),
    app: context.app,
    environment: context.environment,
    source: context.source,
    level: entry.logLevel,
    event: entry.event ?? entry.logType,
    release: context.release,
  };

  const message = messageParts.join(' ');
  if (message.length > 0) {
    event.message = message;
  }

  if (entry.traceId !== undefined) {
    event.traceId = entry.traceId;
  }
  if (entry.requestId !== undefined) {
    event.requestId = entry.requestId;
  }
  if (entry.userId !== undefined) {
    event.userId = entry.userId;
  }
  if (entry.sessionId !== undefined) {
    event.sessionId = entry.sessionId;
  }

  // Payload fields are redacted, depth-bounded and size-bounded before they can
  // reach any sink, so a later sink cannot become the leak.
  if (data.length > 0) {
    event.data = {
      args: redactValue(data, { extraKeys: context.extraRedactedKeys }) as Record<string, unknown>,
    };
  }

  return event;
};
