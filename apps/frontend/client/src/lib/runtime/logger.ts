// apps/frontend/client/src/lib/runtime/logger.ts
//
// Wires the client logger once, at module load.
//
// Local capture for browser events works like this:
//
//     browser --POST /api/telemetry--> Worker (wrangler dev)
//                                        |
//                                  stdout, redirected by
//                                  `bun run dev:api` into
//                                  /tmp/starter-logs/api.ndjson
//
// and `bun run logs --mode local` reads that file.
//
// The important consequence: **a browser cannot write a local file.** An
// earlier version of this file attached a Node NDJSON sink here, which simply
// cannot work in a browser (and broke the bundle by pulling `node:fs` in).
// Forwarding to the Worker is the only route that actually produces a file.

import { BrowserLogger, createHttpTelemetryTransport } from '@starter/logger';
import { clientConfig } from './config.ts';

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

export const clientLogger = new BrowserLogger({
  app: 'client',
  environment: clientConfig.environment,
  source: 'browser',
  release: clientConfig.release,
  logLevel: clientConfig.logLevel,
  transport,
});

export { clientLogger as logger };
