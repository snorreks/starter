// apps/backend/jobs/src/schedule_config.test.ts
//
// The schedule, read out of the committed configuration.
//
// This is the negative control for the design's "never deploy both schedules" rule
// and for "enabled only by a configured profile". Those are claims about a file
// that ships, so they are checked against that file — not against a constant that
// merely *should* match it.
//
// The configuration is parsed with a comment stripper rather than with a second
// JSONC library, and the reason is that this file's comments are the design
// record: they explain why minute 17, why the top level has no schedule, and why
// the container cap is two. A parser that rejected them would push that record
// somewhere it cannot be read next to the thing it explains. The stripper is
// therefore deliberately strict — full-line `//` comments only — and the test below
// fails if the file ever uses a form the stripper does not understand, rather than
// mis-parsing it.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINTENANCE_CRON } from '@starter/jobs';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(APP_DIR, 'wrangler.jsonc');
const ENTRY_PATH = join(APP_DIR, 'src/index.ts');

interface WorkflowEntry {
  binding: string;
  class_name: string;
  name: string;
  schedules?: string | string[];
  concurrency?: { limit?: number };
}

interface WranglerConfig {
  name?: string;
  main?: string;
  routes?: unknown[];
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding: string; database_name: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  containers?: Array<{
    name: string;
    class_name: string;
    max_instances?: number;
    instance_type?: string;
    image?: string;
  }>;
  workflows?: WorkflowEntry[];
  env?: Record<string, WranglerConfig>;
}

/**
 * JSONC to JSON, by removing full-line `//` comments and trailing commas.
 *
 * A second JSONC library would be the obvious choice and is refused for a stated
 * reason: this file's comments *are* the design record — why minute 17, why the top
 * level carries no schedule, why the cap is two — and a parser that rejected them
 * would push that record somewhere it cannot be read next to the thing it explains.
 *
 * The stripper is deliberately strict. A block comment or a trailing comment after a
 * value throws with a message naming the construct, rather than being silently
 * mis-parsed: a test that quietly mis-reads its own configuration is worse than no
 * test, because the invariants below would be asserted against nothing.
 */
const stripComments = (source: string): string => {
  if (/\/\*[\s\S]*?\*\//.test(source)) {
    throw new Error(
      'apps/backend/jobs/wrangler.jsonc uses a block comment. This stripper understands ' +
        'full-line `//` comments only, and a guess about the others would mis-parse the file.',
    );
  }
  if (/\S\/\//.test(source.replace(/^\s*\/\/.*$/gm, ''))) {
    throw new Error(
      'apps/backend/jobs/wrangler.jsonc has a trailing `//` comment. Put comments on their ' +
        'own line so this stripper cannot mistake one for part of a value.',
    );
  }
  return (
    source
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
      // Trailing commas are legal JSONC and are what a human writes when a list is
      // still being edited; `JSON.parse` refuses them.
      .replace(/,(\s*[}\]])/g, '$1')
  );
};

const config = (): WranglerConfig =>
  JSON.parse(stripComments(readFileSync(CONFIG_PATH, 'utf8'))) as WranglerConfig;

const scheduledBindings = (workflows: WorkflowEntry[] | undefined): string[] =>
  (workflows ?? [])
    .filter((workflow) => workflow.schedules !== undefined)
    .map((workflow) => workflow.binding);

describe('the committed maintenance schedule', () => {
  test('the top-level configuration carries no schedule at all', () => {
    // A local run and a default deploy read the top level. If the schedule were
    // here, a template checkout would ask Cloudflare's scheduler to run maintenance
    // on an account that has provisioned nothing.
    expect(scheduledBindings(config().workflows)).toEqual([]);
  });

  test('each deployed environment schedules maintenance on the frozen cron, once', () => {
    const environments = Object.entries(config().env ?? {});
    expect(environments.map(([name]) => name).sort()).toEqual(['production', 'staging']);

    for (const [name, section] of environments) {
      const scheduled = scheduledBindings(section.workflows);
      // Exactly one binding, and it is maintenance. Two would mean two sweeps of the
      // same slot, and the wrong one would be a sweep nobody can explain.
      expect(scheduled, `${name} schedules`).toEqual(['MAINTENANCE_WORKFLOW']);

      const maintenance = section.workflows?.find(
        (workflow) => workflow.binding === 'MAINTENANCE_WORKFLOW',
      );
      expect(maintenance?.schedules).toEqual([MAINTENANCE_CRON]);
    }
  });

  test('the encode workflow is never scheduled', () => {
    // An encode scheduler would be an autonomous, repeating, billable video
    // encoder. Its existence is the failure this whole PR is structured to avoid.
    for (const section of Object.values(config().env ?? {})) {
      for (const workflow of section.workflows ?? []) {
        expect(workflow.binding === 'ENCODE_WORKFLOW' && workflow.schedules !== undefined).toBe(
          false,
        );
      }
    }
  });

  test('the compute profile is enabled exactly where maintenance is scheduled', () => {
    // One variable decides both. A deployment with the schedule but a disabled
    // profile would sweep an environment whose jobs Worker refuses to encode, and
    // one with the profile but no schedule would accumulate jobs nothing ever
    // recovers.
    const top = config();
    expect(top.vars?.JOBS_PROFILE).toBe('disabled');
    for (const [, section] of Object.entries(config().env ?? {})) {
      expect(section.vars?.JOBS_PROFILE).toBe('encode');
    }
  });
});

describe('the configuration as a whole', () => {
  test('web and jobs share a distinct MEDIA bucket for each deployed environment', () => {
    const web = JSON.parse(
      stripComments(readFileSync(join(APP_DIR, '../../frontend/client/wrangler.jsonc'), 'utf8')),
    ) as WranglerConfig;
    const names: string[] = [];
    for (const environment of ['staging', 'production']) {
      const jobsBucket = config().env?.[environment]?.r2_buckets?.find(
        (bucket) => bucket.binding === 'MEDIA',
      )?.bucket_name;
      const webBucket = web.env?.[environment]?.r2_buckets?.find(
        (bucket) => bucket.binding === 'MEDIA',
      )?.bucket_name;
      expect(jobsBucket).toBe(`starter-media-${environment}`);
      expect(webBucket).toBe(jobsBucket);
      names.push(jobsBucket as string);
    }
    expect(new Set(names).size).toBe(2);
  });

  test('this Worker has no route and no public API', () => {
    const document = config();
    // `routes` absent means no custom domain; the default is workers.dev only if a
    // deployment asks for it. Neither is configured here.
    expect(document.routes).toBeUndefined();
    const entry = readFileSync(ENTRY_PATH, 'utf8');
    // The entry must not export a queue consumer or a `scheduled` handler either:
    // a second trigger for the same sweep is what "never both" rules out at the
    // code level, and the schedule above is the only one.
    expect(entry).not.toMatch(/\bscheduled\s*(?:\(|:)/);
    expect(entry).not.toMatch(/async\s+queue\s*\(/);
  });

  test('the database and the bucket are the ones the web Worker shares', () => {
    // Sharing is the design: one environment-isolated D1 and one private bucket.
    // A second database name here would be a second store that maintenance cannot
    // sweep and the web Worker cannot read.
    const document = config();
    expect(document.d1_databases?.[0]?.database_name).toBe('starter-web');
    expect(document.r2_buckets?.[0]?.binding).toBe('MEDIA');
  });

  test('the container cap is two instances on the measured profile', () => {
    const [container] = config().containers ?? [];
    expect(container?.class_name).toBe('EncodeContainer');
    expect(container?.max_instances).toBe(2);
    // `basic` is what apps/backend/media's measurements chose; `standard-1` would
    // buy about a second on a job that runs a handful of times an hour.
    expect(container?.instance_type).toBe('basic');
    // The image is the crate PR G built, not a registry tag somebody may move.
    expect(container?.image).toContain('media');
  });

  test('every deployed environment declares the bindings the Worker requires', () => {
    // Non-inheritable keys are not inherited: an environment that omits `r2_buckets`
    // deploys a Worker whose code asks for `MEDIA` and gets nothing.
    for (const [, section] of Object.entries(config().env ?? {})) {
      expect(section.d1_databases?.map((binding) => binding.binding)).toContain('DB');
      expect(section.r2_buckets?.map((binding) => binding.binding)).toContain('MEDIA');
      expect(section.durable_objects?.bindings.map((binding) => binding.name)).toContain(
        'CONTAINER',
      );
      expect(section.workflows?.map((workflow) => workflow.binding).sort()).toEqual([
        'ENCODE_WORKFLOW',
        'MAINTENANCE_WORKFLOW',
      ]);
    }
  });
});
