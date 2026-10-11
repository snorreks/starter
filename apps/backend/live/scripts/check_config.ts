// apps/backend/live/scripts/check_config.ts
//
// The invariants of this Worker's committed configuration, checked at build time
// rather than at deploy time.
//
// Each of these is a way the configuration can be *almost* right, which is worse
// than being obviously wrong: a deploy that publishes is a deploy that has already
// decided it works.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(APP_DIR, 'wrangler.jsonc');

/** Strip `//` comments so the JSONC can be parsed without a JSONC parser. */
const withoutComments = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

interface Config {
  readonly durable_objects?: {
    readonly bindings?: readonly { binding: string; class_name: string }[];
  };
  readonly migrations?: readonly { tag: string; new_sqlite_classes?: readonly string[] }[];
  readonly services?: readonly { binding: string; service: string }[];
  readonly vars?: Record<string, string>;
  readonly env?: Record<string, Pick<Config, 'vars' | 'services'>>;
}

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const config = JSON.parse(withoutComments(readFileSync(CONFIG_PATH, 'utf8'))) as Config;

const binding =
  config.durable_objects?.bindings?.find((entry) => entry.binding === 'LIVE_HUB') ??
  fail('LIVE_HUB has no Durable Object binding.');
if (binding.class_name !== 'LiveHub') {
  fail(`LIVE_HUB names class "${binding.class_name}"; the exported class is LiveHub.`);
}

for (const scope of [config, ...Object.values(config.env ?? {})]) {
  if (!scope.services?.some((entry) => entry.binding === 'AUTHORIZE' && entry.service.length > 0)) {
    fail('AUTHORIZE has no application Worker service binding.');
  }
}

const migration = config.migrations?.find((entry) => entry.new_sqlite_classes?.includes('LiveHub'));
if (migration === undefined) {
  fail(
    'No migration introduces LiveHub. A Durable Object class without one cannot be deployed, and the failure arrives as an upload error rather than as a build error.',
  );
}

// The decisive one: a committed signing key would verify against a deployed
// Worker. A local placeholder that cannot satisfy the length check is refused at
// runtime, which is the failure we want to be loud about.
const scopes = [config, ...Object.values(config.env ?? {})];
if (scopes.some((scope) => (scope.vars?.LIVE_TICKET_SECRET?.length ?? 0) >= 32)) {
  fail(
    'wrangler.jsonc carries a LIVE_TICKET_SECRET long enough to sign with. That is a credential in the repository; install it with `deploy:provision` instead.',
  );
}

process.stdout.write(
  'Live Worker configuration: LIVE_HUB bound to LiveHub, AUTHORIZE bound, migration present, no committed signing key.\n',
);
