import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RuntimeDescriptor,
  readRuntimeDescriptor,
  verifyRuntimeIdentity,
  writeRuntimeDescriptor,
} from '../src/agent/runtime_descriptor.ts';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const descriptor = (): RuntimeDescriptor => ({
  schemaVersion: 1,
  runId: 'agent_runtime_test123',
  checkout: '/checkout with spaces',
  profile: 'built',
  origins: { web: 'http://127.0.0.1:54123' },
  browserExecutable: '/chromium',
  buildIdentity: 'a'.repeat(64),
  identityVerified: true,
  artifactRoot: '/checkout with spaces/.wrangler/runs/agent_runtime_test123/artifacts',
  logRoot: '/checkout with spaces/.wrangler/runs/agent_runtime_test123/logs',
});

test('a runtime descriptor round-trips atomically with its identity and paths intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-descriptor-'));
  temporary.push(root);
  const path = join(root, 'runtime.json');
  await writeRuntimeDescriptor(path, descriptor());
  expect(await readRuntimeDescriptor(path)).toEqual(descriptor());
});

test('unknown descriptor fields are rejected rather than ignored on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-descriptor-invalid-'));
  temporary.push(root);
  const path = join(root, 'runtime.json');
  await writeFile(path, JSON.stringify({ ...descriptor(), pid: 1234 }));
  await expect(readRuntimeDescriptor(path)).rejects.toThrow(/unknown key.*pid/i);
});

test('a live health response must match run identity and the declared web origin', async () => {
  const identity = descriptor();
  const success = await verifyRuntimeIdentity(identity, async (url) =>
    Response.json({ ok: true, service: 'web', testRunId: identity.runId, baseUrl: url.origin }),
  );
  expect(success).toMatchObject({
    verified: true,
    runId: identity.runId,
    origin: identity.origins.web,
  });

  await expect(
    verifyRuntimeIdentity(identity, async (url) =>
      Response.json({ ok: true, service: 'web', testRunId: 'another-run', baseUrl: url.origin }),
    ),
  ).rejects.toThrow(/identity mismatch/);

  await expect(
    verifyRuntimeIdentity(identity, async () =>
      Response.json({
        ok: true,
        service: 'web',
        testRunId: identity.runId,
        baseUrl: 'http://localhost:54123',
      }),
    ),
  ).rejects.toThrow(/origin mismatch/);
});

test('an oversized streamed health response is cancelled at the identity limit', async () => {
  const identity = descriptor();
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );

  await expect(verifyRuntimeIdentity(identity, async () => response)).rejects.toThrow(/16 KiB/);
  expect(cancelled).toBe(true);
});
