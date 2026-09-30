// scripts/src/lib/logs/registry.ts
//
// The single bridge to the app registry.
//
// Every adapter resolves its capabilities through here rather than keeping its
// own table. The app registry in `@starter/schemas` is the one place that knows
// what an app can be asked for; a second copy here is how a staging query ends
// up hitting production.
//
// The Pi log tool calls the same `runQuery`, so an agent and a human get the
// same answers to the same question.

import {
  APP_LOG_CONFIG,
  DEPLOYMENT_CONFIG,
  capabilitiesFor,
  resolveLogAdapter,
  type AppId,
  type DeploymentEnvironment,
  type LogAdapterCapabilities,
  type LogAdapterKind,
} from '@starter/schemas';

export {
  APP_LOG_CONFIG,
  DEPLOYMENT_CONFIG,
  capabilitiesFor,
  resolveLogAdapter,
};
export type { AppId, DeploymentEnvironment, LogAdapterCapabilities, LogAdapterKind };

/** Does this deployment have a Worker name configured at all? */
export const isProvisioned = (app: AppId): boolean => {
  const name = DEPLOYMENT_CONFIG.workerNames[app];
  return typeof name === 'string' && name.length > 0;
};

/**
 * What the operator must do before this query can work.
 *
 * Returned as an actionable message rather than a boolean so the CLI can print
 * the fix instead of "unavailable".
 */
export const prerequisiteFor = (app: AppId, mode: DeploymentEnvironment): string | null => {
  if (mode === 'local') {
    return null;
  }

  if (!isProvisioned(app)) {
    return (
      `No Cloudflare Worker name is configured for "${app}".\n` +
      `  Run: bun run deploy:configure   (it writes wrangler.jsonc for your account)\n` +
      `  Then: bun run deploy:check --dry-run`
    );
  }

  if (mode === 'production' && DEPLOYMENT_CONFIG.d1DatabaseIds.api === null) {
    return (
      'No D1 database id is configured for the API.\n' +
      '  Run: bun run deploy:configure -- --provision'
    );
  }

  return null;
};
