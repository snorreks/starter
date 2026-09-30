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
// depend on SvelteKit generating anything.

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
  { find: /^@starter\/schemas$/, replacement: src('../../../packages/shared/schemas/src/index.ts') },

  // The logger's subpath exports point at `src/lib/*` rather than `src/*`, so
  // they need spelling out.
  { find: /^@starter\/logger\/browser$/, replacement: src('../../../packages/shared/logger/src/lib/browser_logger.ts') },
  { find: /^@starter\/logger\/file$/, replacement: src('../../../packages/shared/logger/src/lib/file_sink.ts') },
  { find: /^@starter\/logger\//, replacement: `${src('../../../packages/shared/logger/src')}/` },
  { find: /^@starter\/logger$/, replacement: src('../../../packages/shared/logger/src/index.ts') },

  { find: /^@starter\/utils\//, replacement: `${src('../../../packages/shared/utils/src')}/` },
  { find: /^@starter\/utils$/, replacement: src('../../../packages/shared/utils/src/index.ts') },

  { find: /^@starter\/frontend-services\//, replacement: `${src('../../../packages/frontend/services/src')}/` },
  { find: /^@starter\/frontend-services$/, replacement: src('../../../packages/frontend/services/src/index.ts') },

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
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
