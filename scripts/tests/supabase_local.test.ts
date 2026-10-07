import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateSupabaseLocal,
  assertSupabaseOwnership,
  ensureSupabasePortsAvailable,
  persistSupabaseOwnership,
  requireContainerRuntime,
  resetSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
  removeOwnedWorkerVars,
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

  test('a local service already using one allocated port makes the run select a free block', async () => {
    const allocation = allocateSupabaseLocal('/checkouts/port-conflict', 'same-run');
    const occupiedPort = allocation.ports.mail;
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(occupiedPort, '0.0.0.0', () => resolve());
    });

    try {
      const selected = await ensureSupabasePortsAvailable(allocation);
      expect(selected.ports.mail).not.toBe(occupiedPort);
      expect(selected.urls.mail).toBe(`http://127.0.0.1:${selected.ports.mail}`);
      expect(selected.ports.postgres).toBe(selected.ports.api + 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
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

  test('user .dev.vars survives and generated vars are private, run-owned, and removed only unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supabase-vars-'));
    const allocation = allocateSupabaseLocal(root, 'owned-vars');
    const userFile = join(root, '.dev.vars');
    const userContents = 'user configuration fixture';
    try {
      await writeFile(userFile, userContents, { mode: 0o600 });
      const generated = await writeOwnedWorkerVars(allocation, {
        STARTER_BACKEND_PROFILE: 'supabase',
      });
      expect(generated.path).toBe(join(allocation.root, 'supabase.dev.vars'));
      expect((await stat(generated.path)).mode & 0o777).toBe(0o600);
      await removeOwnedWorkerVars(generated.path, generated.contents);
      expect(await readFile(userFile, 'utf8')).toBe(userContents);

      const second = await writeOwnedWorkerVars(allocation, { FIXTURE: 'one' });
      await writeFile(second.path, 'changed by another owner');
      await expect(removeOwnedWorkerVars(second.path, second.contents)).rejects.toThrow(
        /changed before teardown/,
      );
      expect(await readFile(second.path, 'utf8')).toBe('changed by another owner');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
