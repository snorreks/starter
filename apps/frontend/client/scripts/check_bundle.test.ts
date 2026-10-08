// apps/frontend/client/scripts/check_bundle.test.ts
//
// The artifact check, against fixture bundles.
//
// Every fixture here is written to a temporary directory, so these tests need no
// build and cannot pass by accident on whatever happens to be in
// `.svelte-kit/cloudflare/`.
//
// Two checks earn this file. The native-import one is older: `@tauri-apps/*` calls
// into a shell that does not exist here, so it compiles, it bundles, and it throws
// when the screen that reaches it first runs.
//
// The server-code one is newer and is the reason the browser half and the Worker
// half of one application need an artifact-level gate at all. They share a build,
// which is exactly the situation in which `drizzle-orm` or `better-auth` ends up
// in a file the browser downloads — and the build stays green when it does.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle } from './check_bundle.ts';

/** A well-formed artifact: a Worker entry, one client chunk, the asset dirs. */
const fixture = (scripts: Record<string, string>, options: { worker?: string } = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  mkdirSync(join(dir, '_app/immutable/entry'), { recursive: true });
  mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
  writeFileSync(
    join(dir, '_worker.js'),
    options.worker ?? 'import { env } from "cloudflare:workers";\nexport default { fetch() {} };\n',
  );
  writeFileSync(join(dir, '_app/immutable/entry/start.abc123.js'), '// entry\n');
  for (const [name, source] of Object.entries(scripts)) {
    writeFileSync(join(dir, `_app/immutable/chunks/${name}`), source);
  }
  return dir;
};

const withDir = (dir: string, body: () => void): void => {
  try {
    body();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const codes = (dir: string): string[] => checkBundle(dir).map((problem) => problem.code);

describe('checkBundle', () => {
  test('an empty directory is reported, not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    withDir(dir, () => {
      expect(codes(dir)).toContain('no_output');
    });
  });

  test('a well-formed artifact passes', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      expect(checkBundle(dir)).toEqual([]);
    });
  });

  test('a missing Worker entrypoint is reported', () => {
    // The build stays green without it. `wrangler deploy` would then publish the
    // assets alone, and every route — page and API — would 404 with a Worker that
    // reported a successful deploy.
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      rmSync(join(dir, '_worker.js'));
      expect(codes(dir)).toContain('no_worker');
    });
  });

  test('a shell with no client assets is reported', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      rmSync(join(dir, '_app/immutable'), { recursive: true, force: true });
      expect(codes(dir)).toContain('no_assets');
    });
  });

  test('a bundle that still imports a native shell is reported', () => {
    const dir = fixture({ 'a.js': 'import { invoke } from "@tauri-apps/api/core";' });
    withDir(dir, () => {
      expect(codes(dir)).toContain('native_import');
    });
  });

  test('the report names the file that carries the native import', () => {
    // Two chunks, only one of them native: a report that cannot say which one
    // leaves the reader searching the whole bundle for it.
    const dir = fixture({
      'clean.js': 'export const b = 2;\n',
      'dirty.js': 'import { invoke } from "@tauri-apps/api/core";\nexport { invoke };',
    });
    withDir(dir, () => {
      const native = checkBundle(dir).filter((problem) => problem.code === 'native_import');
      expect(native).toHaveLength(1);
      expect(native[0]?.message).toContain('dirty.js');
    });
  });

  test('server code in a client chunk is reported, and the file is named', () => {
    for (const marker of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'cloudflare:workers',
      'notes_owner_id_idx',
      'device_codes',
      'account_id',
      'provider_id',
      'email_verified',
      'SUPABASE_SERVICE_ROLE_KEY',
      'private.chat_generations',
      'complete_chat_generation',
      'service_role required',
    ]) {
      const dir = fixture({
        'clean.js': 'export const b = 2;\n',
        'dirty.js': `import x from "${marker}";\nexport { x };`,
      });
      withDir(dir, () => {
        const leaked = checkBundle(dir).filter((p) => p.code === 'server_code_in_client');
        expect(leaked).toHaveLength(1);
        expect(leaked[0]?.message).toContain('dirty.js');
        expect(leaked[0]?.message).toContain(marker);
      });
    }
  });

  test('the session shape the browser parses is not mistaken for a leak', () => {
    // `SessionUserSchema` carries `emailVerified`, which is also a property name in
    // Supabase Auth's schema. A marker list that fires on the browser's own session shape
    // fails a clean build, and the fix people reach for is deleting the marker — which
    // takes the real check with it. The identifiers that only `@starter/database` has
    // carry that weight instead; this pins the collision that was actually hit.
    const dir = fixture({
      'chunk.js':
        'const e={id:"u_1",email:"a@b.test",displayName:"A",provider:"email",emailVerified:true};export{e};\n',
    });
    withDir(dir, () => {
      expect(checkBundle(dir).filter((p) => p.code === 'server_code_in_client')).toEqual([]);
    });
  });

  test('a minified schema leak is caught even though the library name is gone', () => {
    // The measured failure this list was rewritten for. A real negative control —
    // `import { notes } from '@starter/database'` in a client service — produced a
    // green build and a green check under a name-based marker list, because
    // minification removes `drizzle-orm` and keeps the DDL. A marker list that
    // cannot see that is worse than no list: it reports the artifact as clean.
    const dir = fixture({
      'chunk.js': 'const t="notes_owner_id_idx",i="notes_owner_updated_idx";export{t,i};\n',
    });
    withDir(dir, () => {
      const leaked = checkBundle(dir).filter((p) => p.code === 'server_code_in_client');
      expect(leaked).toHaveLength(1);
      expect(leaked[0]?.message).toContain('chunk.js');
    });
  });

  test('the Worker entrypoint is exempt: it is where that code belongs', () => {
    // The check is about what the *browser* downloads. Failing `_worker.js` would
    // make this unpassable, and an assertion that can never pass is an assertion
    // nobody reads.
    const dir = fixture(
      {},
      {
        worker:
          'import { env } from "cloudflare:workers";\nimport { drizzle } from "drizzle-orm/d1";\n' +
          'const s = "SUPABASE_SERVICE_ROLE_KEY";\nexport default { fetch() { return new Response(s + !!drizzle + !!env); } };\n',
      },
    );
    withDir(dir, () => {
      expect(checkBundle(dir)).toEqual([]);
    });
  });

  test('a loopback URL in the bundle is not itself a failure', () => {
    // A static scan cannot tell a guarded fallback from an unconditional
    // destination, so asserting on a URL asserts nothing. This test exists so
    // nobody "fixes" the check by banning the string.
    const dir = fixture({
      'a.js': 'const b = process.env.API_ORIGIN ?? "http://127.0.0.1:5173";\nexport { b };',
    });
    withDir(dir, () => {
      expect(checkBundle(dir)).toEqual([]);
    });
  });
});
