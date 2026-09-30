// apps/frontend/client/scripts/check_bundle.ts
//
//   bun run --cwd apps/frontend/client check:bundle
//
// Verify the built SPA is the artifact it claims to be.
//
// `vite build` exiting 0 is necessary and not sufficient. The failure modes this
// catches are ones that produce a green build and a broken site:
//
//   * no output at all (a mis-set adapter `pages`/`assets` path, or a build that a
//     cache should not have restored)
//   * no `index.html`, so every deep link 404s
//   * no emitted assets — a shell with no code, which renders blank rather than
//     erroring
//   * **the wrong build mode.** A browser bundle that still imports `@tauri-apps/*`
//     ships native calls that throw; a native bundle built with the stub in place
//     ships an app whose native layer is a stub. Both are silent.
//
// It reads the real `build/` directory `vite build` wrote, and it takes the
// *expected mode* as an argument, because "is this bundle native or browser" is not
// something a static scan can infer — but "does this bundle match the mode it was
// built for" is, and that is the defect worth catching.
//
// Note on what this deliberately does NOT assert: that the bundle contains no
// loopback URL. It does contain `http://127.0.0.1:8787`, in a branch guarded by
// `isTauri()`, and that is correct: a Tauri webview cannot use a relative `/api`
// URL. A static scan cannot tell a guarded fallback from an unconditional
// destination, so asserting on it would be asserting on nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = fileURLToPath(new URL('../build', import.meta.url));

/**
 * The marker string in `src/lib/platform/tauri_stub.ts`.
 *
 * If that file's message changes, this check stops being able to tell a stubbed
 * bundle from a real one — and would then report success on a native build that is
 * actually stubbed. The guard below asserts the marker is still present.
 */
const STUB_MARKER = 'is a Tauri API and is not available in a browser build';

export type BuildMode = 'browser' | 'native';

export interface BundleProblem {
  code:
    | 'no_output'
    | 'no_index'
    | 'no_assets'
    | 'stub_marker_missing'
    | 'mode_mismatch'
    | 'no_entry_script';
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

/** Whether this repository's stub still carries the marker this check looks for. */
export const stubMarkerIntact = (): boolean => {
  const stub = readIfPresent(
    fileURLToPath(new URL('../src/lib/platform/tauri_stub.ts', import.meta.url)),
  );
  return stub?.includes(STUB_MARKER);
};

/**
 * Inspect a built bundle directory.
 *
 * `dir` and `mode` are parameters so a fixture bundle can be written to a
 * temporary directory and checked without building anything.
 */
export const checkBundle = (mode: BuildMode, dir: string = BUILD_DIR): BundleProblem[] => {
  const files = listFiles(dir);

  if (!stubMarkerIntact()) {
    // Reported before anything else: without the marker, the mode check below
    // would pass on a native bundle built with the stub in place.
    return [
      {
        code: 'stub_marker_missing',
        message:
          'The Tauri stub marker string was not found in src/lib/platform/tauri_stub.ts, so this ' +
          'check cannot distinguish a stubbed bundle from a real one.',
        remedy: `Restore the phrase "${STUB_MARKER}" in the stub's error message, or update STUB_MARKER here.`,
      },
    ];
  }

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

  if (!files.includes('index.html')) {
    problems.push({
      code: 'no_index',
      message: 'No index.html in the build output.',
      remedy:
        'The SPA fallback is missing, so every deep link returns 404. Check the adapter ' +
        "option in vite.config.ts (`fallback: 'index.html'`, `pages: 'build'`).",
    });
  }

  const assetFiles = files.filter((file) => file.startsWith('_app/immutable/'));
  if (assetFiles.length === 0) {
    problems.push({
      code: 'no_assets',
      message: 'No files under _app/immutable/.',
      remedy:
        'The build produced no client assets. SvelteKit wrote a shell with no code, which ' +
        'renders as a blank page rather than an error.',
    });
  }

  const index = readIfPresent(join(dir, 'index.html')) ?? '';
  if (index.length > 0) {
    // SvelteKit's SPA shell does not emit `<script type="module" src=...>`. It emits
    // an inline script with a dynamic `import()` of the entry chunk. An earlier
    // version of this check looked for the module-script form, found nothing, and
    // reported a perfectly good build as broken — so the assertion is written
    // against what SvelteKit actually emits.
    const hasEntry = /_app\/immutable\/entry\/start\.[\w-]+\.js/.test(index);
    if (!hasEntry) {
      problems.push({
        code: 'no_entry_script',
        message: 'index.html does not reference the SvelteKit entry chunk.',
        remedy:
          'The built HTML loads and runs nothing, which renders as a blank page. Check that ' +
          'the routes directory is non-empty and that `prerender.handleUnseenRoutes` is not ' +
          'discarding them.',
      });
    }
  }

  const scripts = files.filter((file) => file.endsWith('.js'));
  let sawStubMarker = false;
  for (const file of scripts) {
    const source = readIfPresent(join(dir, file));
    if (source?.includes(STUB_MARKER)) {
      sawStubMarker = true;
      break;
    }
  }

  if (mode === 'native' && sawStubMarker) {
    problems.push({
      code: 'mode_mismatch',
      message: 'A native build still contains the browser Tauri stub.',
      remedy:
        'TAURI_NATIVE_BUILD was not set for this build, so vite.config.ts aliased ' +
        '`@tauri-apps/*` to the throwing stub. `bun run tauri:build` sets it for every ' +
        'native target, including Android and iOS.',
    });
  }

  if (mode === 'browser' && !sawStubMarker) {
    problems.push({
      code: 'mode_mismatch',
      message: 'A browser build does not contain the Tauri stub.',
      remedy:
        'Either the stub was not applied, or this is a native bundle being checked as a ' +
        'browser bundle. A browser bundle without the stub would import @tauri-apps/* and ' +
        'throw on first use.',
    });
  }

  return problems;
};

export const main = (): number => {
  const mode: BuildMode =
    process.env.TAURI_NATIVE_BUILD === 'true' || process.env.TAURI_DESKTOP_BUILD === 'true'
      ? 'native'
      : 'browser';

  const problems = checkBundle(mode);

  if (problems.length === 0) {
    const files = listFiles(BUILD_DIR).length;
    process.stdout.write(`bundle ok: ${files} file(s) in ${BUILD_DIR} (mode: ${mode})\n`);
    return 0;
  }

  process.stderr.write(`bundle check failed for ${BUILD_DIR} (mode: ${mode})\n`);
  for (const problem of problems) {
    process.stderr.write(`  [${problem.code}] ${problem.message}\n`);
    process.stderr.write(`      ${problem.remedy}\n`);
  }
  return 1;
};

if (import.meta.main) {
  process.exitCode = main();
}
