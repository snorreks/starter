import { describe, expect, test } from 'bun:test';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateSupabaseLocal,
  assertSupabaseOwnership,
  persistSupabaseOwnership,
  requireContainerRuntime,
  resetSupabaseLocal,
  stopSupabaseLocal,
} from '../src/db/supabase_local.ts';

describe('isolated local Supabase allocation', () => {
  test('persisting the same allocation replaces every link without failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supabase-links-'));
    const allocation = { ...allocateSupabaseLocal(root, 'repeat-run'), root };
    try {
      await persistSupabaseOwnership(allocation);
      await persistSupabaseOwnership(allocation);
      for (const name of ['migrations', 'tests', 'seed.sql']) {
        expect(await readlink(join(root, 'supabase-project', 'supabase', name))).toEndWith(
          `/supabase/${name}`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('two checkout allocations have distinct project ids and every exposed port', () => {
    const first = allocateSupabaseLocal('/checkouts/first', 'run-one');
    const second = allocateSupabaseLocal('/checkouts/second', 'run-two');

    expect(first.projectId).not.toBe(second.projectId);
    expect(new Set(Object.values(first.ports)).size).toBe(6);
    expect(new Set(Object.values(second.ports)).size).toBe(6);
    expect(
      Object.values(first.ports).some((port) => Object.values(second.ports).includes(port)),
    ).toBe(false);
    expect(first.urls.api).toBe(`http://127.0.0.1:${first.ports.api}`);
    expect(first.urls.postgres).toContain(`127.0.0.1:${first.ports.postgres}/`);
    expect(first.urls.studio).toBe(`http://127.0.0.1:${first.ports.studio}`);
    expect(first.urls.mail).toBe(`http://127.0.0.1:${first.ports.mail}`);
    expect(first.urls.smtp).toBe(`127.0.0.1:${first.ports.smtp}`);
    expect(first.urls.pop3).toBe(`127.0.0.1:${first.ports.pop3}`);
  });

  test('stale ownership cannot stop or reset another allocation', async () => {
    const owner = allocateSupabaseLocal('/checkouts/owner', 'owner-run');
    const other = allocateSupabaseLocal('/checkouts/other', 'other-run');

    expect(() => assertSupabaseOwnership(owner, other)).toThrow(/ownership identity mismatch/);
    await expect(stopSupabaseLocal(owner, other)).rejects.toThrow(/ownership identity mismatch/);
    await expect(resetSupabaseLocal(owner, other)).rejects.toThrow(/ownership identity mismatch/);
  });

  test('an absent container runtime is a named nonzero failure', () => {
    expect(() => requireContainerRuntime({ dockerPath: undefined })).toThrow(
      /Docker-compatible container runtime is required/,
    );
  });
});
