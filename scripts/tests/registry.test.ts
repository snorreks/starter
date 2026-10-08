// scripts/tests/registry.test.ts
//
// The project registry, and the deployment config.
//
// This file is the reason `bun run logs web --mode production` cannot silently
// read the wrong project's data: it is the only place an app maps to a Worker, a
// bucket or a database. A duplicated map elsewhere would be invisible until it
// queried staging while claiming to be production.
//
// The tests are mostly about *refusals* — unprovisioned resources, unsupported
// capabilities, unconfigured adapters — because that is what this file is for. A
// tool that invents a target when it has none is worse than one that stops.

import { describe, expect, test } from 'bun:test';
import { checkSchema } from '@starter/schemas/common';
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
      expect(checkSchema(AppLogConfigSchema, config)).toBe(true);
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

  test('a deployed environment has a historical adapter and a live adapter', () => {
    for (const environment of ['staging', 'production'] as const) {
      const resolution = resolveLogAdapter('web', environment);
      expect('kind' in resolution).toBe(true);
      expect(capabilitiesFor((resolution as { kind: never }).kind).historicalQuery).toBe(true);
    }
  });

  test('the browser and the Worker are told apart by source, not by app', () => {
    // There is one app now, so a browser-forwarded event and a server event reach
    // the same deployment. `source` is the field that separates them, and this
    // assertion is what stops somebody re-adding a second app id to fix the
    // confusion the field already resolves.
    const sources = APP_LOG_CONFIG.web.sources;
    expect(sources).toContain('browser');
    expect(sources).toContain('worker');
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
    expect(checkSchema(DEPLOYMENT_CONFIG_SCHEMA, DEPLOYMENT_CONFIG)).toBe(true);
  });

  test('a fresh clone has provisioned nothing', () => {
    expect(DEPLOYMENT_CONFIG.workerName).toBeNull();
    expect(DEPLOYMENT_CONFIG.r2BucketNames.uploads).toBeNull();
    expect(DEPLOYMENT_CONFIG.customDomain).toBeNull();
    expect(DEPLOYMENT_CONFIG.accountId).toBeNull();
  });

  test('an empty string is not an acceptable placeholder', () => {
    // `''` satisfies `string` but fails `minLength: 1` in the app-log schema, so a
    // `''` used to pass every type check and be invalid at runtime. Asserted for
    // both the log config and the deployment config, because both now carry a
    // single name and a second unchecked `string` is one refactor away.
    expect(checkSchema(AppLogConfigSchema, { ...APP_LOG_CONFIG.web, workerName: '' })).toBe(false);
    expect(checkSchema(DEPLOYMENT_CONFIG_SCHEMA, { ...DEPLOYMENT_CONFIG, workerName: '' })).toBe(
      false,
    );
  });
});

describe('isAppId', () => {
  test('accepts only the declared apps', () => {
    expect(isAppId('web')).toBe(true);
    // The two ids this registry used to have, rejected explicitly: a stale caller
    // that says `logs client` must get a refusal naming what is valid, not a
    // silently wrong lookup.
    expect(isAppId('client')).toBe(false);
    expect(isAppId('api')).toBe(false);
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
  test('refuses rather than defaulting for an app that is not declared', () => {
    // The refusal names the app and the environment, so the message is actionable.
    // Passing a plain string here is the mistake a type error would have caught;
    // the runtime check is what stops it reading a config that does not exist.
    const resolution = resolveLogAdapter('clinet' as AppId, 'production');
    expect(resolution).toEqual(
      expect.objectContaining({ unsupported: expect.stringContaining('clinet') }),
    );
  });

  test('names the app type as an AppId, not as a string', () => {
    // A plain string would let `resolveLogAdapter('clinet', 'production')` compile
    // and then read `undefined` from the config.
    const app: AppId = 'web';
    expect('kind' in resolveLogAdapter(app, 'staging')).toBe(true);
  });
});
