// apps/frontend/client/scripts/check_bundle.ts
//
//   bun run --cwd apps/frontend/client check:bundle
//
// Verify the built artifact is a deployable Worker plus its static assets.
//
// `vite build` exiting 0 is necessary and not sufficient. The failure modes this
// catches are ones that produce a green build and a broken deploy:
//
//   * no output at all (a mis-set `assets.directory`, or a build that a cache
//     should not have restored)
//   * no `_worker.js`. `wrangler deploy` would then ship a static site with no
//     server: every `/api/*` call 404s and every page is a 404 too, because there
//     is nothing to render them.
//   * no emitted client assets — a Worker that serves a shell with no code
//   * **a native import that survived into the bundle.** `@tauri-apps/*` calls a
//     shell that does not exist in this starter, so such a call throws at runtime,
//     on whichever screen reaches it first, and nothing in the build reports it.
//   * **server code in a client chunk.** The browser half and the Worker half of
//     one application share a build, which is exactly the situation in which
//     `drizzle-orm` or `better-auth` can end up in a file the browser downloads.
//     A green build is still a green build in that case, and the result is a
//     published database driver plus an auth implementation sitting in public
//     assets.
//
// The last one is the assertion this file grew for. It is deliberately a marker
// scan rather than a module-graph check: the graph work belongs to the resolved
// dependency guard, and a text scan here is a cheap second gate that runs on the
// artifact itself rather than on the source.
//
// What it deliberately does NOT assert: that the bundle contains no loopback URL.
// A static scan cannot tell a guarded fallback from an unconditional destination,
// so asserting on that would be asserting on nothing. The bundle must not contain
// a *secret marker* or a server *implementation*, and those two are checkable.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(relative, import.meta.url)` resolves against *this file*, which lives in
// `apps/frontend/client/scripts/`. One `../` is wrong in a way that reads as a
// missing build rather than as a path bug: it points at `apps/frontend/.svelte-kit`,
// which does not exist. `paths.test.ts` guards the shared copy of this same idea in
// the tooling workspace.
const BUILD_DIR = fileURLToPath(new URL('../.svelte-kit/cloudflare', import.meta.url));

/** The Worker entrypoint `wrangler.jsonc` points `main` at. */
const WORKER_ENTRY = '_worker.js';

/**
 * A specifier for a native shell, matched against every emitted script.
 *
 * Kept as a plain string rather than a module name so a re-added `@tauri-apps/*`
 * dependency fails this check instead of quietly reaching the browser.
 */
const NATIVE_SPECIFIER = '@tauri-apps/';

/**
 * Markers that must not appear in a file the browser downloads.
 *
 * A secret marker and a server implementation are different failures with the same
 * consequence — a credential or a data-access library published as a static asset —
 * so they are one check with one list, reported per file so the reader knows which
 * chunk to look at.
 *
 * **These have to be strings that survive minification.** The obvious choice —
 * `drizzle-orm`, `better-auth` — does not work, and the reason is worth recording
 * because it was measured rather than assumed: a client module that imports
 * `@starter/database` bundles cleanly and the library *name* is gone, while the
 * schema it carries survives as a string. A negative control (`import { notes }
 * from '@starter/database'` in `notes_service.svelte.ts`) produced a green
 * `vite build`, a green `check:bundle` under a name-based list, and a client chunk
 * containing the `notes_owner_id_idx` DDL.
 *
 * So the list is distinctive identifiers from the server-only packages, which is
 * what a real leak actually contains. The D1 table and index names are the sharpest
 * of these: they exist nowhere else, and they are in the SQL Drizzle emits, so they
 * are present whenever a table definition is.
 */
const SERVER_MARKERS = [
  // Configuration secret names from `src/lib/server/env.ts`.
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  // The Workers bindings module. Resolved to a stub in dev, so it never appears in
  // a client chunk even when the import is there.
  'cloudflare:workers',
  // Drizzle/D1 table, column and index names from `@starter/database`. A row
  // definition is the thing that leaks when a server package is reachable from browser
  // code.
  'notes_owner_id_idx',
  'notes_owner_updated_idx',
  'device_codes',
  'account_id',
  'provider_id',
  // Better Auth's own DDL, snake-cased the way this application's migrations spell it.
  'email_verified',
  // `emailVerified` was on this list and is deliberately not any more. It is the
  // property name Better Auth's schema carries, and it is *also* a field of
  // `SessionUserSchema` in `@starter/schemas` — which the browser is supposed to
  // parse the signed-in user with. A marker that fires on correct code is a marker
  // somebody deletes to make the build green, and `email_verified` plus the D1
  // identifiers above catch the same leak without firing on the session shape. That
  // collision was found by `bun run check:bundle` failing on a clean build, not by
  // inspection: the one occurrence in the client bundle was the schema the browser
  // needs.
] as const;

export interface BundleProblem {
  code: 'no_output' | 'no_worker' | 'no_assets' | 'native_import' | 'server_code_in_client';
  message: string;
  remedy: string;
}

/** Every file under `dir`, relative, depth-first. */
export const listFiles = (dir: string): string[] => {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const nested of listFiles(full)) {
        found.push(join(entry, nested));
      }
      continue;
    }
    found.push(entry);
  }
  return found;
};

const readIfPresent = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Inspect a built artifact directory.
 *
 * `dir` is a parameter so a fixture bundle can be written to a temporary
 * directory and checked without building anything.
 */
export const checkBundle = (dir: string = BUILD_DIR): BundleProblem[] => {
  const files = listFiles(dir);

  if (files.length === 0) {
    return [
      {
        code: 'no_output',
        message: `${dir} does not exist or is empty.`,
        remedy: 'Run `bun run build` in apps/frontend/client first.',
      },
    ];
  }

  const problems: BundleProblem[] = [];

  if (!files.includes(WORKER_ENTRY)) {
    problems.push({
      code: 'no_worker',
      message: `No ${WORKER_ENTRY} in the build output.`,
      remedy:
        'The deployable unit is a Cloudflare Worker plus its static assets, and the Worker ' +
        'is what serves the HTML, the API and the session cookie. Without it, `wrangler ' +
        'deploy` publishes assets alone and every route 404s. Check `main` and ' +
        '`assets.directory` in wrangler.jsonc, and that the adapter is @sveltejs/adapter-cloudflare.',
    });
  }

  const clientAssets = files.filter(
    (file) => file.startsWith('_app/immutable/') && file.endsWith('.js'),
  );
  if (clientAssets.length === 0) {
    problems.push({
      code: 'no_assets',
      message: 'No client modules under _app/immutable/.',
      remedy:
        'The build produced no client assets. SvelteKit wrote a shell with no code, which ' +
        'renders as a blank page rather than an error.',
    });
  }

  // Reported per file rather than once, because "which module" is the difference
  // between a fixable report and a hunt.
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = readIfPresent(join(dir, file));

    if (source?.includes(NATIVE_SPECIFIER)) {
      problems.push({
        code: 'native_import',
        message: `${file} imports "${NATIVE_SPECIFIER}…", and this starter has no native shell.`,
        remedy:
          'A `@tauri-apps/*` call reaches a shell that does not exist and throws when that ' +
          'screen runs. Remove the import; `bun run check:bundle` fails it until you do.',
      });
    }

    // The Worker entrypoint is the one file *supposed* to contain all of this.
    if (file === WORKER_ENTRY || !source) {
      continue;
    }

    const leaked = SERVER_MARKERS.filter((marker) => source.includes(marker));
    if (leaked.length > 0) {
      problems.push({
        code: 'server_code_in_client',
        message: `${file} contains ${leaked.map((m) => `"${m}"`).join(', ')}.`,
        remedy:
          'That file is served to the browser as a static asset. A database driver, an auth ' +
          'implementation, a secret name or a `cloudflare:workers` import in a client chunk ' +
          'means server code crossed the boundary. Move it into src/lib/server/** or a ' +
          '+server.ts route adapter, which SvelteKit only builds into the Worker.',
      });
    }
  }

  return problems;
};

export const main = (): number => {
  const problems = checkBundle();

  if (problems.length === 0) {
    const files = listFiles(BUILD_DIR).length;
    process.stdout.write(`bundle ok: ${files} file(s) in ${BUILD_DIR}\n`);
    return 0;
  }

  process.stderr.write(`bundle check failed for ${BUILD_DIR}\n`);
  for (const problem of problems) {
    process.stderr.write(`  [${problem.code}] ${problem.message}\n`);
    process.stderr.write(`      ${problem.remedy}\n`);
  }
  return 1;
};

if (import.meta.main) {
  process.exitCode = main();
}
