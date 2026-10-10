// scripts/tests/service_registry.test.ts
//
// The registry answers "what is this app?", and a wrong answer here is a deploy
// step that does nothing or a local stack that starts something nobody asked for.
//
// These tests run against a *fixture* tree, not the repository, so the failure
// cases can be made real: asserting that the checker refuses an entry would
// otherwise mean breaking the repository to find out.

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHASES as PIPELINE_PHASES } from '../src/deploy/apply.ts';

// Widened on purpose at the import site: `apply.ts` types its list as the narrow
// `Phase[]`, which makes every comparison against another phase list a type error
// and tempts a cast at the point of use. Widening once here states the real claim:
// the registry and the pipeline declare the same set of selectable phases.
const PHASES: readonly string[] = PIPELINE_PHASES;

import { LOCAL_SERVICE_IDS } from '../src/local/service.ts';
import {
  orderedLocalServices,
  requiredLocalServices,
  SERVICE_IDS,
  SERVICE_KINDS,
  SERVICE_PHASES,
  SERVICE_REGISTRY,
  serviceById,
  serviceRegistryProblems,
} from '../src/registry/service_registry.ts';

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'service-registry-'));
  for (const config of Object.values(SERVICE_REGISTRY)) {
    await mkdir(join(root, config.path), { recursive: true });
  }
  return root;
};

describe('the registry describes this repository', () => {
  test('every entry resolves to a path that exists and has a plane', () => {
    // An entry for a directory nobody created is a plan that deploys nothing and
    // reports success; an entry with no plane is one the architecture guard cannot
    // check any boundary of.
    expect(serviceRegistryProblems()).toEqual([]);
  });

  test('only the web application has a public origin', () => {
    // The jobs Worker answers 404 to every request by design. Treating it as
    // addressable produces a deploy that "verifies" against something that cannot
    // serve a request.
    const addressable = Object.values(SERVICE_REGISTRY)
      .filter((config) => config.addressable)
      .map((config) => config.id);
    expect(addressable).toEqual(['web']);
  });

  test('every service kind is one this repository actually uses', () => {
    const used = new Set(Object.values(SERVICE_REGISTRY).map((config) => config.kind));
    for (const kind of used) {
      expect(SERVICE_KINDS).toContain(kind);
    }
  });

  test('a service nobody asked about is not in the registry', () => {
    // The registry is discovered from what exists, not a wish list. `apps/backend/analytics`
    // appearing here without a decision would be a plan for an app that does not exist.
    expect(serviceById('analytics')).toBeUndefined();
    expect(serviceById('web')?.path).toBe('apps/frontend/client');
  });
});

describe('the registry and the pipeline agree on phases', () => {
  test('the declared phase list is exactly what `deploy apply` will run', () => {
    // Checked rather than imported: importing would make these two modules depend
    // on each other's load order, and a divergence here means `deploy apply
    // --only <phase>` accepts a phase no service participates in — or, worse, that
    // one silently does nothing.
    expect([...SERVICE_PHASES].sort().join(',')).toBe([...PHASES].sort().join(','));
  });

  test('every phase a service declares is one the pipeline has', () => {
    // `PHASES` and the `Phase` type are deliberately different widths: the type
    // includes `build` and `validate`, which are pipeline steps rather than
    // `--only` selectors. What a service may declare is the narrower list.
    for (const config of Object.values(SERVICE_REGISTRY)) {
      for (const phase of config.phases) {
        expect(PHASES).toContain(phase);
      }
    }
  });
});

describe('local requirements are deduplicated and ordered', () => {
  test('two apps needing one container start it once', () => {
    // `media` and `jobs` both require `container`. Starting stripe-mock — or a
    // container build — twice binds the same port twice.
    const required = requiredLocalServices(['jobs', 'media']);
    expect(required.filter((id) => id === 'container')).toHaveLength(1);
  });

  test('the order is the declared one, not the order they were named', () => {
    expect(orderedLocalServices(['jobs', 'stripe', 'supabase'])).toEqual([
      'supabase',
      'stripe',
      'jobs',
    ]);
  });

  test('an app nobody asked for contributes nothing', () => {
    expect(requiredLocalServices(['native'])).toEqual([]);
  });

  test('every required service is a service that exists', () => {
    for (const id of SERVICE_IDS) {
      for (const service of serviceById(id)?.requires ?? []) {
        expect(LOCAL_SERVICE_IDS).toContain(service);
      }
    }
  });
});

describe('the registry checker refuses what it cannot vouch for', () => {
  test('a missing directory is refused with the remedy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'service-registry-missing-'));
    await mkdir(join(root, 'apps/frontend/client'), { recursive: true });

    const problems = serviceRegistryProblems(root);

    // Every entry but `web` is absent from this fixture, and each must be named
    // rather than skipped: a skipped entry deploys nothing and reports success.
    const subjects = problems.map((problem) => problem.subject);
    expect(subjects).toContain('jobs');
    expect(subjects).toContain('media');
    for (const problem of problems) {
      expect(problem.remedy.length).toBeGreaterThan(0);
    }
  });

  test('a fixture where everything exists produces no problems', async () => {
    expect(serviceRegistryProblems(await fixture())).toEqual([]);
  });
});
