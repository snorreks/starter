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
//   * **a native import that survived into the bundle.** `@tauri-apps/*` calls
//     into a native shell that does not exist in this starter, so such a call
//     throws at runtime, on whichever screen reaches it first. Nothing in the
//     build reports it, which is why it is asserted here.
//
// The last one replaced a two-mode check. There were once a browser and a native
// bundle, distinguished by a build flag, and the bundle had to carry the right
// marker for the mode it was checked in. There is one target now, so the check
// asserts the property directly instead of matching a bundle against a label.
//
// Note on what this deliberately does NOT assert: that the bundle contains no
// loopback URL. It can contain `http://127.0.0.1:8787`, in the branch that
// resolves the API base URL during a server render where there is no origin to be
// relative to, and that is correct. A static scan cannot tell a guarded fallback
// from an unconditional destination, so asserting on it would be asserting on
// nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = fileURLToPath(new URL('../build', import.meta.url));

/**
 * A specifier for a native shell, matched against every emitted script.
 *
 * Kept as a plain string rather than a module name so a re-added `@tauri-apps/*`
 * dependency fails this check instead of quietly reaching the browser.
 */
const NATIVE_SPECIFIER = '@tauri-apps/';

export interface BundleProblem {
  code: 'no_output' | 'no_index' | 'no_assets' | 'no_entry_script' | 'native_import';
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
 * Inspect a built bundle directory.
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