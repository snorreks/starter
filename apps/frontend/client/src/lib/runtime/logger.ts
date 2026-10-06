// apps/frontend/client/src/lib/runtime/logger.ts
//
// Wires the client logger once, at module load.
//
// Local capture for browser events works like this:
//
//     browser --POST /api/telemetry--> the same Worker
//                                        |
//                                  stdout, redirected by
//                                  `bun run dev` into
//                                  .wrangler/logs/app.ndjson
//
// and `bun run logs web --mode local` reads that file.
//
// The important consequence: **a browser cannot write a local file.** An
// earlier version of this file attached a Node NDJSON sink here, which simply
// cannot work in a browser (and broke the bundle by pulling `node:fs` in).
// Forwarding to the Worker is the only route that actually produces a file.

import {
  BrowserLogger,
  ConsoleLogger,
  createHttpTelemetryTransport,
  type LoggerInterface,
  setLogger,
} from '@starter/logger';
import { clientConfig } from './config.ts';

const createBrowserLogger = (): BrowserLogger => {
  const transport =
    clientConfig.telemetryEndpoint === undefined
      ? undefined
      : createHttpTelemetryTransport({
          endpoint: clientConfig.telemetryEndpoint,
          context: () => ({
            appVersion: clientConfig.release,
            platform: navigator.userAgent.slice(0, 100),
            userAgent: navigator.userAgent.slice(0, 200),
          }),
        });

  return new BrowserLogger({
    app: 'web',
    environment: clientConfig.environment,
    source: 'browser',
    release: clientConfig.release,
    logLevel: clientConfig.logLevel,
    transport,
  });
};

const createServerLogger = (): ConsoleLogger =>
  new ConsoleLogger(
    {
      app: 'web',
      environment: clientConfig.environment,
      source: 'worker',
      release: clientConfig.release,
    },
    { logLevel: clientConfig.logLevel },
  );

/** Browser telemetry logger or the server's console logger, selected per bundle. */
const isBrowser = typeof window !== 'undefined';
export const logger: LoggerInterface = isBrowser ? createBrowserLogger() : createServerLogger();

// BaseClass and other shared services use the package logger indirection.
setLogger(logger);
