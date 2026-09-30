// apps/frontend/client/src/lib/runtime/logger.ts
//
// Wires the client logger once, at module load.
//
// Two sinks, and the reason for each is different:
//   - console: what a developer sees in devtools
//   - NDJSON file: what `bun run logs client --mode local` reads. This is the
//     only local path that can also be asserted on in a test, so it is a real
//     sink rather than a devtools convenience.

import {
  BrowserLogger,
  createHttpTelemetryTransport,
  NdjsonFileSink,
  resolveRelease,
  setLogger,
} from '@starter/logger';
import { clientConfig } from './config.ts';

const logFilePath = '/tmp/starter-logs/client.ndjson';

// Only the local environment writes files. In staging/production the browser's
// only route is the telemetry endpoint, and writing to a local path there would
// silently drop everything.
const sinks =
  clientConfig.environment === 'local' ? [new NdjsonFileSink(logFilePath)] : [];

const transport =
  clientConfig.telemetryEndpoint === undefined
    ? undefined
    : createHttpTelemetryTransport({
        endpoint: clientConfig.telemetryEndpoint,
        context: () => ({
          appVersion: clientConfig.release,
          platform: navigator.userAgent.slice(0, 200),
          userAgent: navigator.userAgent.slice(0, 200),
        }),
      });

export const clientLogger = new BrowserLogger({
  app: 'client',
  environment: clientConfig.environment,
  source: 'browser',
  release: resolveRelease(clientConfig.release),
  logLevel: clientConfig.logLevel,
  sinks,
  transport,
});

setLogger(clientLogger);
