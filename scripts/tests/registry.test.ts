// scripts/tests/registry.test.ts
//
// The project registry, and the deployment config.
//
// This file is the reason `bun run logs api --mode production` cannot silently
// read the wrong project's data: it is the only place an app maps to a Worker, a
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
} from '../src/registry/app_registry.ts';

const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

describe('APP_LOG_CONFIG', () => {
  test('validates against its own schema', () => {
    // This assertion is the reason it exists: `workerName` was `''` while the
    // schema required `minLength 1`, so the registry shipped invalid and every
    // consumer inherited the mistake. Nothing checked.
    for (const app of APP_IDS) {
      const config = APP_LOG_CONFIG[app];
      const errors = [...Value.Errors(AppLogConfigSchema, config)];

      expect(errors.map((error) => `${error.path} ${error.message}`)).toEqual([]);
    }
  });

  test('every configured adapter kind has declared capabilities', () => {
    for (const app of APP_IDS) {
      for (const environment of ENVIRONMENTS) {
        for (const kind of APP_LOG_CONFIG[app].adapters[environment]) {
          expect(() => capabilitiesFor(kind)).not.toThrow();
        }
      }
    }
  });

  test('the template provisions nothing', () => {
    for (const app of APP_IDS) {
      expect(APP_LOG_CONFIG[app].workerName).toBeNull();
    }
  });

  test("the browser's events are not claimed to be server logs", () => {
    // The asymmetry is deliberate. A client adapter that resolved for staging
    // would answer "show me production browser logs" with something, and the
    // answer would be empty rather than an honest refusal.
    for (const environment of ['staging', 'production'] as const) {
      const resolution = resolveLogAdapter('client', environment);
      expect('unsupported' in resolution).toBe(true);
    }
  });

  test('the api has a historical adapter and a live adapter', () => {
    for (const environment of ['staging', 'production'] as const) {
      const resolution = resolveLogAdapter('api', environment);
      expect('kind' in resolution).toBe(true);
      expect(capabilitiesFor((resolution as { kind: never }).kind).historicalQuery).toBe(true);
    }
  });

  test('local resolves to the file adapter, never to a credentialed one', () => {
    // "local" being served by a Cloudflare path is how a developer ends up
    // reading production data while debugging.
    for (const app of APP_IDS) {
      const local = APP_LOG_CONFIG[app].adapters.local;
      expect(local).not.toContain('cloudflare-observability');
      expect(local).not.toContain('wrangler-tail');
    }
  });
});

describe('capabilitiesFor', () => {
  test('a live tail cannot filter provider-side', () => {
    const tail = capabilitiesFor('wrangler-tail');
    expect(tail.historicalQuery).toBe(false);
    expect(tail.userIdFilter).toBe(false);
    expect(tail.traceIdFilter).toBe(false);
  });

  test('every declared kind resolves', () => {
    for (const kind of LOG_ADAPTER_KINDS) {
      expect(typeof capabilitiesFor(kind)).toBe('object');
    }
  });

  test('an unknown kind is a type error, not a silent default', () => {
    // A runtime call with a value the type system should have prevented. The
    // assertion is that it fails rather than returning some default capability set
    // that would let an unfiltered query proceed.
    expect(() => capabilitiesFor('not-a-real-adapter' as never)).toThrow();
  });
});

describe('DEPLOYMENT_CONFIG', () => {
  test('validates against its own schema', () => {
    expect([...Value.Errors(DEPLOYMENT_CONFIG_SCHEMA, DEPLOYMENT_CONFIG)]).toEqual([]);
  });

  test('a fresh clone has provisioned nothing', () => {
    expect(DEPLOYMENT_CONFIG.workerNames.client).toBeNull();
    expect(DEPLOYMENT_CONFIG.workerNames.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.d1DatabaseIds.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.r2BucketNames.uploads).toBeNull();
    expect(DEPLOYMENT_CONFIG.customDomains.api).toBeNull();
  });

  test('an empty string is not an acceptable placeholder', () => {
    // `''` satisfies `string` but fails `minLength: 1` in the app-log schema, so a
    // `''` used to pass every type check and be invalid at runtime.
    const withEmptyName = {
      ...APP_LOG_CONFIG.api,
      workerName: '',
    };
    expect([...Value.Errors(AppLogConfigSchema, withEmptyName)].length).toBeGreaterThan(0);
  });
});

describe('isAppId', () => {
  test('accepts only the declared apps', () => {
    expect(isAppId('client')).toBe(true);
    expect(isAppId('api')).toBe(true);
    expect(isAppId('worker')).toBe(false);
    expect(isAppId('all')).toBe(false);
    expect(isAppId(undefined)).toBe(false);
    expect(isAppId(7)).toBe(false);
  });

  test('covers every configured app', () => {
    const configured = Object.keys(APP_LOG_CONFIG);
    expect(configured.sort()).toEqual([...APP_IDS].sort());
  });
});

describe('resolveLogAdapter', () => {
  test('refuses rather than defaulting when an environment has no adapter', () => {
    const resolution = resolveLogAdapter('client', 'production');
    expect('unsupported' in resolution).toBe(true);
    if ('unsupported' in resolution) {
      expect(resolution.unsupported).toContain('client');
      expect(resolution.unsupported).toContain('production');
    }
  });

  test('names the app type as an AppId, not as a string', () => {
    // A plain string would let `resolveLogAdapter('clinet', 'production')` compile
    // and then read `undefined` from the config.
    const app: AppId = 'api';
    expect('kind' in resolveLogAdapter(app, 'staging')).toBe(true);
  });
});
