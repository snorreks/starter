// scripts/tests/dev_stack.test.ts
//
// Choosing what `bun run dev` starts. The failures asserted here are all of the
// shape "the run looked fine and did less than it said", which is the class this
// repository treats as worse than an outright error.

import { describe, expect, test } from 'bun:test';
import {
  DEV_STACK_NAMES,
  describeStack,
  parseStackSpec,
  resolveStack,
  stackChoices,
  startStack,
} from '../src/dev-stack.ts';
import type { LocalService, LocalServiceId } from '../src/local/service.ts';

describe('a named stack resolves to services', () => {
  test('full is every service, in start order', () => {
    const resolved = resolveStack('full');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error('full did not resolve');
    }
    expect(resolved.services).toEqual(['supabase', 'stripe', 'container', 'jobs']);
  });

  test('a combination of services is accepted alongside named stacks', () => {
    const resolved = resolveStack('supabase,stripe');
    expect(resolved.ok && resolved.services).toEqual(['supabase', 'stripe']);
  });

  test('start order is declared, not the order they were typed', () => {
    // Typed `jobs,supabase` and typed `supabase,jobs` must produce one run, or the
    // same command produces different infrastructure depending on how it was read.
    const a = resolveStack('jobs,supabase');
    const b = resolveStack('supabase,jobs');
    expect(a.ok && a.services).toEqual(b.ok ? b.services : []);
  });
});

describe('an unknown stack is refused, never skipped', () => {
  test('a typo names itself and the real options', () => {
    const parsed = parseStackSpec('supres');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('a typo resolved');
    }
    expect(parsed.problem).toContain('supres');
    expect(parsed.remedy).toContain('client');
  });

  test('one bad token refuses the whole list rather than starting the rest', () => {
    // The failure this prevents: `--stack supabase,stripe,strip` starting two
    // services, reporting success, and missing the third.
    const parsed = parseStackSpec('supabase,stripe,strip');
    expect(parsed.ok).toBe(false);
  });

  test('an empty specification is a refusal with the options', () => {
    const parsed = parseStackSpec('  ,  ');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('an empty stack resolved');
    }
    expect(parsed.remedy).toContain('client');
  });
});

describe('a stack always brings up what the application needs', () => {
  test('naming only stripe still starts the database the app reads from', () => {
    // The app is a registry entry with `requires: ['supabase']`. Without this the
    // developer gets a checkout page that 503s on save, and no explanation.
    const resolved = resolveStack('stripe');
    expect(resolved.ok && resolved.services).toContain('supabase');
    expect(resolved.ok && resolved.services).toContain('stripe');
  });

  test('the services pulled in by the registry are reported, so the extra is visible', () => {
    const resolved = resolveStack('stripe');
    expect(resolved.ok && resolved.fromApps).toContain('web');
  });
});

describe('a stack that fails part-way leaves nothing behind', () => {
  test('services already started are disposed in reverse before the error propagates', async () => {
    const started: LocalServiceId[] = [];
    const stopped: LocalServiceId[] = [];
    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      if (id === 'container') {
        throw new Error('no Rust toolchain');
      }
      started.push(id);
      return {
        id,
        label: id,
        owned: true,
        vars: {},
        summary: [],
        dispose: async () => {
          stopped.push(id);
          return [];
        },
      };
    };

    await expect(startStack(['supabase', 'stripe', 'container', 'jobs'], factory)).rejects.toThrow(
      'no Rust toolchain',
    );

    // Two databases and a container behind a failed `bun run dev` is how a machine
    // ends up with orphaned stacks nobody can attribute to a port.
    expect(started).toEqual(['supabase', 'stripe']);
    expect(stopped).toEqual(['stripe', 'supabase']);
  });
});

describe('the banner reports what actually started', () => {
  test('the merged bindings and the labels come from the services themselves', () => {
    const described = describeStack([
      {
        id: 'supabase',
        label: 'Local Supabase',
        owned: true,
        vars: { SUPABASE_URL: 'http://127.0.0.1:54321' },
        summary: ['Local Supabase -> http://127.0.0.1:54321'],
        dispose: async () => [],
      },
    ]);
    expect(described.vars).toEqual({ SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(described.summary[0]).toBe('Local Supabase');
  });
});

describe('the menu cannot fall out of step with the stacks', () => {
  test('every named stack is offered, and every offer describes itself', () => {
    // A stack added to the registry but not to the prompt is invisible, which is
    // how a feature ships and nobody can find.
    const offered = stackChoices().map((choice) => choice.id);
    expect(offered).toEqual([...DEV_STACK_NAMES]);
    for (const choice of stackChoices()) {
      expect(choice.detail.length).toBeGreaterThan(0);
      expect(choice.services.length).toBeGreaterThan(0);
    }
  });
});
