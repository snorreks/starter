// packages/shared/schemas/src/registry/app_registry.test.ts
//
// The single project registry, and the deployment config.
//
// This file is the reason `bun run logs --mode production` cannot silently read
// the wrong project's data: it is the only place an app maps to a worker, a
// bucket or a database. A duplicated map elsewhere would be invisible until it
// queried staging while claiming to be production.
//
// The tests are mostly about *refusals* — unprovisioned resources, unsupported
// capabilities, unconfigured adapters — because that is what this file is for. A
// tool that invents a target when it has none is worse than one that stops.

import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  APP_IDS,
  APP_LOG_CONFIG,
  type AppId,
  AppLogConfigSchema,
  capabilitiesFor,
  DEPLOYMENT_CONFIG,
  DEPLOYMENT_CONFIG_SCHEMA,
  isAppId,
  LOG_ADAPTER_KINDS,
  resolveLogAdapter,
} from './index.ts';

const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

describe('APP_LOG_CONFIG', () => {
  test('validates against its own schema', () => {
    // This assertion is the reason it exists: `workerName` was `''` while the
    // schema required `minLength: 1`, so the registry shipped invalid and every
    // consumer inherited the mistake. Nothing checked.
    for (const app of APP_IDS) {
      const config = APP_LOG_CONFIG[app];
      const errors = [...Value.Errors(AppLogConfigSchema, config)];

      expect(errors.map((error) => `${error.path} ${error.message}`)).toEqual([]);
    }
  });

  test('has an entry for every declared app', () => {
    for (const app of APP_IDS) {
      expect(APP_LOG_CONFIG[app]).toBeDefined();
      expect(APP_LOG_CONFIG[app].app).toBe(app);
    }
  });

  test('provisions no worker names, so nothing points at another project', () => {
    // A hard invariant for a template: a fresh clone must reference no
    // inherited resource. A non-null worker name here would mean someone pasted
    // a real one in.
    for (const app of APP_IDS) {
      expect(APP_LOG_CONFIG[app].workerName).toBeNull();
    }
  });

  test('declares an adapter list for every environment', () => {
    for (const app of APP_IDS) {
      for (const environment of ENVIRONMENTS) {
        expect(Array.isArray(APP_LOG_CONFIG[app].adapters[environment])).toBe(true);
      }
    }
  });

  test('names only adapter kinds that exist', () => {
    for (const app of APP_IDS) {
      for (const environment of ENVIRONMENTS) {
        for (const kind of APP_LOG_CONFIG[app].adapters[environment]) {
          expect(LOG_ADAPTER_KINDS as readonly string[]).toContain(kind);
        }
      }
    }
  });

  test('local always resolves to the credential-free adapter', () => {
    // Otherwise local log queries would need credentials, and the whole point of
    // `--mode local` is that it works in ordinary CI.
    for (const app of APP_IDS) {
      expect(APP_LOG_CONFIG[app].adapters.local).toContain('local-file');
    }
  });

  test('only worker sources appear for the api', () => {
    expect(APP_LOG_CONFIG.api.sources).toEqual(['worker']);
  });

  test('the client declares no server-side source', () => {
    // Honest about the asymmetry: browser events are not server logs, so they
    // are never claimed to be readable from Cloudflare here.
    expect(APP_LOG_CONFIG.client.sources).not.toContain('worker');
  });

  test('the client has no cloudflare adapter in any environment', () => {
    // Round 1 does not enable client telemetry forwarding. If someone wires it
    // up, these lists change — and the test says so.
    for (const environment of ['staging', 'production'] as const) {
      expect(APP_LOG_CONFIG.client.adapters[environment]).toEqual([]);
    }
  });
});

describe('isAppId', () => {
  test('accepts declared apps', () => {
    for (const app of APP_IDS) {
      expect(isAppId(app)).toBe(true);
    }
  });

  test('rejects anything else', () => {
    // The CLI takes this from argv, so it must reject rather than coerce.
    for (const value of ['all', 'API', '', 'toString', null, undefined, 42, {}, ['api']]) {
      expect(isAppId(value)).toBe(false);
    }
  });

  test('does not accept inherited prototype names', () => {
    // A naive `in` or `Object.keys` check on a config object would accept
    // `constructor` and `toString`.
    expect(isAppId('constructor')).toBe(false);
    expect(isAppId('toString')).toBe(false);
    expect(isAppId('__proto__')).toBe(false);
  });
});

describe('resolveLogAdapter', () => {
  test('resolves local to the file adapter for both apps', () => {
    for (const app of APP_IDS) {
      const result = resolveLogAdapter(app, 'local');
      expect(result).toEqual({ kind: 'local-file' });
    }
  });

  test('resolves a cloudflare environment for the api', () => {
    const result = resolveLogAdapter('api', 'production');
    expect(result).toEqual({ kind: 'cloudflare-logpush' });
  });

  test('refuses for the client in a cloudflare environment, and says why', () => {
    // Not an error message about a misconfiguration — a statement of fact about
    // where browser logs can exist. A user who asks for production client logs
    // deserves the real reason, not "unknown error".
    const result = resolveLogAdapter('client', 'production');

    expect('kind' in result).toBe(false);
    if ('kind' in result) {
      return;
    }

    expect(result.unsupported).toContain('client');
    expect(result.unsupported).toContain('production');
    expect(result.unsupported.toLowerCase()).toContain('forward');
  });

  test('the refusal names both the app and the environment', () => {
    // So a message pasted into an issue is actionable on its own.
    const result = resolveLogAdapter('client', 'staging');
    if ('kind' in result) {
      throw new Error('expected a refusal');
    }

    expect(result.unsupported).toContain('client');
    expect(result.unsupported).toContain('staging');
  });
});

describe('capabilitiesFor', () => {
  test('every declared adapter kind has capabilities', () => {
    for (const kind of LOG_ADAPTER_KINDS) {
      expect(capabilitiesFor(kind)).toBeDefined();
    }
  });

  test('a live tail cannot filter by user id', () => {
    // The declaration that turns `--uid` into a `capability_unsupported` error
    // rather than an unbounded dump of every user's events.
    expect(capabilitiesFor('wrangler-tail').userIdFilter).toBe(false);
    expect(capabilitiesFor('wrangler-tail').historicalQuery).toBe(false);
  });

  test('a live tail offers neither history nor a cursor', () => {
    const tail = capabilitiesFor('wrangler-tail');

    expect(tail.historicalQuery).toBe(false);
    expect(tail.cursor).toBe(false);
    expect(tail.liveTail).toBe(true);
  });

  test('logpush is the only adapter with both history and a cursor', () => {
    const withBoth = LOG_ADAPTER_KINDS.filter(
      (kind) => capabilitiesFor(kind).historicalQuery && capabilitiesFor(kind).cursor,
    );

    expect(withBoth).toEqual(['cloudflare-logpush']);
  });

  test('client-forward is local-only, never historical', () => {
    // It can filter on a stored user id, but has no provider index, so it must
    // not be offered as a historical source.
    const forward = capabilitiesFor('client-forward');

    expect(forward.userIdFilter).toBe(true);
    expect(forward.historicalQuery).toBe(false);
    expect(forward.liveTail).toBe(false);
  });

  test('local-file supports filtering but not a cursor', () => {
    const local = capabilitiesFor('local-file');

    expect(local.userIdFilter).toBe(true);
    expect(local.traceIdFilter).toBe(true);
    expect(local.cursor).toBe(false);
  });
});

describe('DEPLOYMENT_CONFIG', () => {
  test('validates against its own schema', () => {
    const errors = [...Value.Errors(DEPLOYMENT_CONFIG_SCHEMA, DEPLOYMENT_CONFIG)];

    expect(errors.map((error) => `${error.path} ${error.message}`)).toEqual([]);
  });

  test('provisions nothing', () => {
    // Every resource id is null in the template. A non-null value would be a
    // real id belonging to whoever ran the extraction last.
    expect(DEPLOYMENT_CONFIG.workerNames.client).toBeNull();
    expect(DEPLOYMENT_CONFIG.workerNames.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.d1DatabaseIds.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.r2BucketNames.uploads).toBeNull();
    expect(DEPLOYMENT_CONFIG.customDomains.client).toBeNull();
    expect(DEPLOYMENT_CONFIG.customDomains.api).toBeNull();
  });

  test('covers both apps, so the deploy dry-run can report per app', () => {
    for (const app of APP_IDS) {
      expect(DEPLOYMENT_CONFIG.workerNames).toHaveProperty(app);
      expect(DEPLOYMENT_CONFIG.customDomains).toHaveProperty(app);
    }
  });
});

describe('registry is the only source', () => {
  test('every AppId has a log config and every log config has a known app', () => {
    // Guards against the two drifting apart: an app added to APP_IDS without a
    // config would make the CLI throw a TypeError on a typo.
    const configured = Object.keys(APP_LOG_CONFIG).sort();

    expect(configured).toEqual([...APP_IDS].sort());
  });

  test('no adapter list duplicates a kind', () => {
    // A duplicate would be tried twice for one query.
    for (const app of APP_IDS) {
      for (const environment of ENVIRONMENTS) {
        const kinds = APP_LOG_CONFIG[app].adapters[environment];
        expect(new Set(kinds).size).toBe(kinds.length);
      }
    }
  });
});

describe('AppId', () => {
  test('is a union of the declared ids only', () => {
    // Compile-time only; this test documents the intent that the type and the
    // value list cannot diverge, and would fail to compile if they did.
    const ids: readonly AppId[] = APP_IDS;
    expect(ids).toEqual(['client', 'api']);
  });
});
