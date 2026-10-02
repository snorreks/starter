// packages/shared/logger/src/lib/default_logger.ts
//
// The process-wide logger.
//
// `BaseClass` lives in `@starter/utils` and must not know which app it is in,
// so it logs through this indirection. Each application calls `setLogger()` once
// at startup with its real context; until then the context is derived from the
// environment, and if that is also absent the values below are used.
//
// Those fallbacks are intentionally boring and unclaimed (`app: 'scripts'`,
// `source: 'cli'`) rather than plausible-looking. A log that confidently
// reports the wrong app is worse than one that reports a generic one, because
// the first gets trusted in a triage that the second would have prompted.

import type { DeploymentEnvironment, LogApp, LogSource } from '@starter/schemas/logging';
import { ConsoleLogger } from './console_logger.ts';
import { resolveRelease } from './event_log.ts';

const readEnv = (key: string): string | undefined => {
  // Vite inlines `import.meta.env.*` at build time for the browser bundle;
  // `process.env` covers the Worker, the CLI and tests.
  const viteValue = (import.meta as unknown as { env?: Record<string, unknown> }).env?.[key];
  if (typeof viteValue === 'string' && viteValue.length > 0) {
    return viteValue;
  }
  return typeof process !== 'undefined' ? process.env[key] : undefined;
};

const toLogApp = (raw: string | undefined): LogApp => {
  switch (raw) {
    case 'client':
    case 'api':
    case 'scripts':
      return raw;
    default:
      return 'scripts';
  }
};

const toEnvironment = (raw: string | undefined): DeploymentEnvironment => {
  switch (raw) {
    case 'local':
    case 'staging':
    case 'production':
      return raw;
    default:
      return 'local';
  }
};

const toSource = (raw: string | undefined): LogSource => {
  switch (raw) {
    case 'browser':
    case 'worker':
    case 'cli':
      return raw;
    default:
      return 'cli';
  }
};

const toLogLevel = (raw: string | undefined): 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'NONE' => {
  switch (raw?.toUpperCase()) {
    case 'DEBUG':
    case 'INFO':
    case 'WARNING':
    case 'ERROR':
    case 'NONE':
      return raw.toUpperCase() as 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'NONE';
    default:
      return 'INFO';
  }
};

export const createDefaultLogger = (): ConsoleLogger =>
  new ConsoleLogger(
    {
      app: toLogApp(readEnv('PUBLIC_APP_ID')),
      environment: toEnvironment(readEnv('PUBLIC_MODE')),
      source: toSource(readEnv('PUBLIC_LOG_SOURCE')),
      release: resolveRelease(readEnv('PUBLIC_APP_VERSION') ?? readEnv('APP_VERSION')),
    },
    { logLevel: toLogLevel(readEnv('PUBLIC_LOG_LEVEL') ?? readEnv('LOG_LEVEL')) },
  );

let current: ConsoleLogger | undefined;

/** Install the app's real logger. Call once, at startup, before any logging. */
export const setLogger = (logger: ConsoleLogger): void => {
  current = logger;
};

export const getLogger = (): ConsoleLogger => (current ??= createDefaultLogger());

/** Drop the installed logger. Used by tests to isolate logger state. */
export const resetLogger = (): void => {
  current = undefined;
};
