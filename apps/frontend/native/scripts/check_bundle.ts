// apps/frontend/native/scripts/check_bundle.ts
//
//   bun run --cwd apps/frontend/native check:bundle
//
// Verify the built artifact is a static bundle for the Tauri shell, and that the
// two application bundles in this repository cannot be confused with each other.
//
// `vite build` exiting 0 is necessary and not sufficient. Three failures produce
// a green build and a broken app:
//
//   * **No `index.html`.** The adapter's `fallback` is what answers a deep link
//     like `/notes`; without it the shell resolves the request against the
//     directory and finds nothing.
//   * **No client modules.** A shell with no code renders as a blank window.
//   * **Server code in a static asset.** This bundle is the *other* half of the
//     same product as the web Worker, and it ships inside a binary that anybody
//     with the installer can unpack. A D1 table name, a secret *name* or a
//     `cloudflare:workers` import in here is a credential or a data-access
//     library published to every user.
//
// The last is the same idea as `apps/frontend/client/scripts/check_bundle.ts`,
// with the direction reversed, and it is deliberately a marker scan on the
// artifact rather than a graph check: the graph belongs to the guard, and this
// runs on the bytes that will actually ship.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(relative, import.meta.url)` resolves against *this file*, which lives in
// `apps/frontend/native/scripts/`. Two `../` would point at `apps/frontend/`,
// which does not contain a build output.
const BUILD_DIR = fileURLToPath(new URL('../build', import.meta.url));

/** The prerendered shell. Named in the adapter's `fallback`. */
const FALLBACK_PAGE = 'index.html';

/**
 * Markers that must not appear anywhere in the shipped frontend.
 *
 * Chosen for the same reason as the web app's list, and with the same discipline:
 * a marker that fires on correct code is a marker somebody deletes to make the
 * build green. So `emailVerified` is absent (the browser needs it, from
 * `@starter/schemas`) while the D1 column spellings are present — those exist
 * nowhere else and are in the SQL Drizzle emits.
 *
 * `BETTER_AUTH_URL` is a *name*, not a value, and it is still worth refusing: a
 * file that mentions it is a file that imported the server's configuration.
 */
const SERVER_MARKERS = [
  'cloudflare:workers',
  'workerd',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'notes_owner_id_idx',
  'notes_owner_updated_idx',
  'device_codes',
  'email_verified',
  'drizzle-orm',
] as const;

/**
 * Markers that must not appear in the *web* build.
 *
 * Asserted here rather than only in `apps/frontend/client` so both halves of this
 * check live in one place and one `bun run` reports both. The web app's own
 * `check:bundle` still asserts this independently — two controls for one
 * property is deliberate when the property is "the browser bundle does not reach
 * for a native API".
 */
export const WEB_BUILD_DIR = fileURLToPath(
  new URL('../../client/.svelte-kit/cloudflare', import.meta.url),
);

const NATIVE_SPECIFIER = '@tauri-apps/';

export interface BundleProblem {
  code: 'no_output' | 'no_fallback' | 'no_assets' | 'server_code_in_bundle' | 'native_import_in_web';
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

const scanFor = (
  dir: string,
  files: readonly string[],
  markers: readonly string[],
  onFound: (file: string, marker: string) => BundleProblem,
): BundleProblem[] =>
  files
    .filter((file) => file.endsWith('.js') || file.endsWith('.html'))
    .flatMap((file) => {
      const source = readIfPresent(join(dir, file));
      if (source === undefined || source === null) {
        return [];
      }
      return markers.filter((marker) => source.includes(marker)).map((marker) => onFound(file, marker));
    });

/**
 * Inspect a built static bundle.
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
        remedy: 'Run `bun run native:build` in apps/frontend/native first.',
      },
    ];
  }

  const problems: BundleProblem[] = [];

  if (!files.includes(FALLBACK_PAGE)) {
    problems.push({
      code: 'no_fallback',
      message: `No ${FALLBACK_PAGE} in the build output.`,
      remedy:
        'Run `bun run native:build` first. Then check that `fallback` is ' +
        "'index.html' in vite.config.ts and that the root layout is prerendered.",
    });
  }

  const assets = files.filter((file) => file.startsWith('_app/immutable/') && file.endsWith('.js'));
  if (assets.length === 0) {
    problems.push({
      code: 'no_assets',
      message: 'No client modules under _app/immutable/.',
      remedy:
        'The build produced no client assets: the shell would open a blank window rather ' +
        'than an error.',
    });
  }

  problems.push(
    ...scanFor(dir, files, SERVER_MARKERS, (file, marker) => ({
      code: 'server_code_in_bundle' as const,
      message: `${file} contains "${marker}".`,
      remedy:
        'This file ships inside the desktop installer, where anybody can unpack it. A ' +
        'database identifier, a secret name or a `cloudflare:workers` import here means ' +
        'server code crossed the boundary. Keep it in the web app: this app has no ' +
        'server plane at all.',
    })),
  );

  return problems;
};

/** The other half of the same property: no native API in the web bundle. */
export const checkWebBundle = (dir: string = WEB_BUILD_DIR): BundleProblem[] => {
  const files = listFiles(dir);
  if (files.length === 0) {
    // Not built. `check:bundle` for the web app owns that failure, with the right
    // remedy; reporting it twice would name the wrong directory's command.
    return [];
  }

  return scanFor(dir, files, [NATIVE_SPECIFIER], (file) => ({
    code: 'native_import_in_web' as const,
    message: `${file} imports "${NATIVE_SPECIFIER}…".`,
    remedy:
      'The web bundle is served to browsers, which have no native shell. A `@tauri-apps/*` ' +
      'call reaches an API object that does not exist there. The native bridge belongs in ' +
      'apps/frontend/native/src/lib/platform/**, which is the only directory the guard ' +
      'classifies as native-bridge.',
  }));
};

export const main = (): number => {
  const problems = [...checkBundle(), ...checkWebBundle()];

  if (problems.length === 0) {
    process.stdout.write(
      `bundle ok: ${listFiles(BUILD_DIR).length} file(s) in ${BUILD_DIR}\n`,
    );
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