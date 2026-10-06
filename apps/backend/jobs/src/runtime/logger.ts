// apps/backend/jobs/src/runtime/logger.ts
//
// The jobs Worker emits structured records directly to the Workers console.

import { env } from 'cloudflare:workers';
import { createLogger, createStructuredConsoleEmitter, setLogger } from '@starter/logger';
import { isDeploymentEnvironment } from '@starter/schemas/logging';

const bindings = env as unknown as {
  DEPLOYMENT_ENV?: string;
  RELEASE?: string;
};
const rawEnvironment = bindings.DEPLOYMENT_ENV;
if (rawEnvironment !== 'development' && !isDeploymentEnvironment(rawEnvironment)) {
  throw new Error(
    'The jobs logger needs DEPLOYMENT_ENV set to local, development, staging, or production.',
  );
}
const environment = rawEnvironment === 'development' ? 'local' : rawEnvironment;
const context = {
  app: 'web' as const,
  environment,
  source: 'worker' as const,
  release: bindings.RELEASE ?? 'dev',
};

export const logger = createLogger({
  ...context,
  silent: true,
  sinks: [createStructuredConsoleEmitter(context)],
});

setLogger(logger);
