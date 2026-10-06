// apps/frontend/native/src/lib/runtime/logger.ts
//
// The native webview logs to its console. The app has no server-side telemetry
// endpoint, so it deliberately installs no browser transport.

import { ConsoleLogger, type LoggerInterface, setLogger } from '@starter/logger';
import { nativeConfig } from './config.ts';

const logger: LoggerInterface = new ConsoleLogger(
  {
    app: 'web',
    environment: nativeConfig.dev ? 'local' : 'production',
    source: 'browser',
    release: 'dev',
  },
  { logLevel: nativeConfig.dev ? 'DEBUG' : 'INFO' },
);

setLogger(logger);

export { logger };
