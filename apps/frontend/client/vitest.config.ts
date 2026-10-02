// apps/frontend/client/vitest.config.ts
//
// Real-Svelte browser tests.
//
// These exist because a plain `bun test` cannot represent the thing that most
// often breaks in this codebase: Svelte 5 reactivity and component lifecycle.
// A ViewModel's `$state` writes, a `$derived` recompute, and the dispose path
// of `BaseViewModelContainer` all depend on the compiler having processed the
// file. Under Bun's runner with stubbed runes they pass no matter what the
// component does.
//
// So: a real browser, the real compiler, no mocking of the runtime.
//
// This config deliberately does NOT extend the SvelteKit Vite config. It stands
// alone, which is why the aliases are spelled out here — resolution must not
// depend on SvelteKit generating anything, and the browser lane has to keep
// working in a checkout where `svelte-kit sync` has not been run.
//
// `src/dom_repair.d.ts` is loaded through `server.deps.inline` rather than being
// listed in `compilerOptions.types`. That is deliberate: the file exists to merge
// the DOM signatures back over the `Element` interface the Workers runtime types
// declare (sveltejs/kit#8268), and it has to be in the *type* program, which is
// this file's own program — not the application's. See the file for the full
// explanation.

import { fileURLToPath } from 'node:url';
import { vitestProviderOptions } from '../../../scripts/src/shared/browser_path.ts';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const src = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Workspace package aliases.
 *
 * Written as `find` + `replacement` pairs pointing at each package's **src
 * directory**, so that a subpath import resolves as a directory
 * (`@starter/schemas/notes` -> `.../schemas/src/notes/index.ts`).
 *
 * A plain string alias would replace only the leading segment and produce
 * `.../schemas/src/index.ts/notes`, which does not exist — and the resulting
 * error names the wrong file, which costs more time than it saves.
 */
const packageAliases = [
  { find: /^@starter\/schemas\//, replacement: `${src('../../../packages/shared/schemas/src')}/` },
  {
    find: /^@starter\/schemas$/,
    replacement: src('../../../packages/shared/schemas/src/index.ts'),
  },

  // The logger's subpath exports point at `src/lib/*` rather than `src/*`, so they
  // need spelling out.
  {
    find: /^@starter\/logger\/browser$/,
    replacement: src('../../../packages/shared/logger/src/lib/browser_logger.ts'),
  },
  {
    find: /^@starter\/logger\/file$/,
    replacement: src('../../../packages/shared/logger/src/lib/file_sink.ts'),
  },
  { find: /^@starter\/logger\//, replacement: `${src('../../../packages/shared/logger/src')}/` },
  { find: /^@starter\/logger$/, replacement: src('../../../packages/shared/logger/src/index.ts') },

  { find: /^@starter\/utils\//, replacement: `${src('../../../packages/shared/utils/src')}/` },
  { find: /^@starter\/utils$/, replacement: src('../../../packages/shared/utils/src/index.ts') },

  { find: /^@starter\/ui\//, replacement: `${src('../../../packages/frontend/ui/src')}/` },
  { find: /^@starter\/ui$/, replacement: src('../../../packages/frontend/ui/src/index.ts') },
];

export default defineConfig({
  plugins: [svelte()],

  resolve: {
    alias: [
      ...packageAliases,
      // `#lib` is SvelteKit's subpath import. At type level it comes from the
      // generated tsconfig; at runtime it has to be mapped here.
      { find: /^#lib\/(.*)$/, replacement: `${src('./src/lib')}/$1` },
      { find: /^#lib$/, replacement: src('./src/lib') },
      // `$app/*` is only needed by the route components, which this lane does
      // not import. Mapped to a stub so an accidental import fails with a clear
      // message instead of an unresolved-specifier warning.
      {
        find: /^\$app\//,
        replacement: fileURLToPath(new URL('./src/browser_tests/app_stub.ts', import.meta.url)),
      },
    ],
  },

  test: {
    include: ['src/browser_tests/**/*.browser.test.ts', 'tests/**/*.browser.test.ts'],
    setupFiles: ['src/browser_tests/setup.ts'],
    browser: {
      enabled: true,
      // `launchOptions` is the documented `@vitest/browser-playwright` option and
      // the only one the provider reads — `resolveLaunchOptions` in the provider's
      // own dist spreads `providerOptions.launchOptions` and nothing else.
      //
      // It used to be written as an *instance* property, `instances: [{ browser:
      // 'chromium', launch: { executablePath } }]`. `BrowserInstanceOption` has no
      // `launch` member, so TypeScript should have rejected it and Vitest silently
      // dropped it: the option never reached `playwright.launch()`, and the lane
      // died on Playwright's own resolution instead. That is the whole failure,
      // reproduced in docs/capability-matrix.md:
      //
      //   Executable doesn't exist at …/bin/chromium_headless_shell-1243/
      //     chrome-headless-shell-linux64/chrome-headless-shell
      //
      // When the selection was dropped, `headless: true` made Playwright resolve a
      // `chromium_headless_shell-<build>/…` path relative to
      // `PLAYWRIGHT_BROWSERS_PATH`. The dev shell pointed that at the Nix store's
      // `bin` directory — not a Playwright browser layout — so the computed path
      // named a file the store does not contain. `flake.nix` now points it at a
      // cache directory instead, and `scripts/src/setup/setup.ts` decides whether
      // to download by asking `resolveBrowser()` rather than by testing whether a
      // variable starts with `/nix/store`.
      //
      // Installing a second Chromium or switching `channel` cannot fix a path
      // computed from a variable that points at a directory, and the previous note
      // in this file asserted the opposite without having run it.
      //
      // Which Chromium to use is decided once, in
      // `scripts/src/shared/browser_path.ts`, and read by the E2E lane too.
      provider: playwright(vitestProviderOptions()),
      headless: true,
      // An explicit instance keeps the browser named in the output. No launch
      // options here: the provider owns those, per instance or per project.
      instances: [{ browser: 'chromium' }],
    },
  },
});
