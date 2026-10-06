// apps/frontend/native/src/lib/runtime/logger.ts
//
// The native webview logs to its console. The app has no server-side telemetry
// endpoint, so it deliberately installs no browser transport.

import {
  createLogger,
  createStructuredConsoleEmitter,
  type LoggerInterface,
  setLogger,
} from '@starter/logger';
import { nativeConfig } from './config.ts';

const environment: 'local' | 'production' = nativeConfig.dev ? 'local' : 'production';
const context = {
  app: 'web' as const,
  environment,
  source: 'browser' as const,
  release: 'dev',
};
const logger: LoggerInterface = createLogger({
  ...context,
  logLevel: nativeConfig.dev ? 'DEBUG' : 'INFO',
  silent: true,
  sinks: [createStructuredConsoleEmitter(context)],
});

setLogger(logger);

export { logger };
