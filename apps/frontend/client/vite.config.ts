// apps/frontend/client/vite.config.ts
//
// One SvelteKit app, two build targets: a browser SPA and a native bundle.
// Both are the same Vite build; a native build differs only by `TAURI_NATIVE_BUILD`,
// which (a) stops the `@tauri-apps/*` packages from being stubbed away and (b)
// marks the bundle as native at build time.
//
// The flag is named for what it means, not for one platform. It used to be
// `TAURI_DESKTOP_BUILD`, which reads as desktop-only: an Android or iOS build
// launched without it shipped stubbed Tauri packages, i.e. an app whose native
// calls throw. `scripts/build_tauri.ts` sets it for every native target, and the
// old name is still accepted so an existing invocation keeps working.
//
// Keeping one config rather than a `vite.config.tauri.ts` is deliberate: a
// second config is a second thing that can drift, and "works in the browser,
// broken in Tauri" is the exact failure this avoids.
//
// SvelteKit 3 takes its whole configuration inline; there is no
// svelte.config.js.
//
// No `alias` block on purpose: SvelteKit deprecated custom aliases in favour of
// subpath imports. `$lib/...` is built in, and everything outside this app is
// reached through its published package name (`@starter/ui`,
// `@starter/schemas/notes`), which is also what the workspace boundary guard
// reads. An alias map would let a file name a package the guard cannot see.

import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { API_DEV_PORT, CLIENT_DEV_PORT, DEV_HOST } from './dev_ports.ts';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

const isNativeBuild =
  process.env.TAURI_NATIVE_BUILD === 'true' || process.env.TAURI_DESKTOP_BUILD === 'true';

// One authority for both ports: see dev_ports.ts. `src-tauri/tauri.conf.json`
// hard-codes `devUrl` (Tauri v2 does not interpolate env vars into its config),
// and a guard asserts the two agree so the literals cannot drift apart.
const PORT = {
  client: CLIENT_DEV_PORT,
  api: API_DEV_PORT,
} as const;

export default defineConfig({
  // Tauri packages become a throwing stub for browser builds, so importing one
  // by accident fails loudly at runtime instead of quietly shipping a dead
  // native path. A plain Vite alias, not a SvelteKit one: SvelteKit has
  // deprecated its `alias` option in favour of subpath imports, and this is a
  // third-party substitution rather than a project path mapping.
  resolve: {
    alias: isNativeBuild
      ? {}
      : [{ find: /^@tauri-apps\/.*$/, replacement: resolvePath('src/lib/platform/tauri_stub.ts') }],
  },

  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: [vitePreprocess()],
      adapter: adapter({
        // SPA fallback: every route is served by the client router, so the
        // static-asset Worker never needs to know the route table.
        fallback: 'index.html',
        pages: 'build',
        assets: 'build',
      }),
      prerender: {
        handleUnseenRoutes: 'ignore',
      },
      // SvelteKit 3 removed the built-in `$lib` alias. The supported
      // replacement is a subpath import, and this is what makes it work:
      // SvelteKit turns `alias` entries into the generated tsconfig's `paths`,
      // so TypeScript and the bundler resolve the same specifier.
      //
      // A package.json `imports` entry would read better but does not
      // typecheck under TypeScript 6 — it resolves in Vite and Node and then
      // fails in `svelte-check`, which is the worst of the three outcomes.
      // See docs/guides/sveltekit-3-subpaths.md.
      alias: {
        '#lib': 'src/lib',

        // Workspace packages are mapped here, not in `tsconfig.json`, because
        // SvelteKit turns `alias` entries into the generated tsconfig's
        // `paths`. `svelte-check` follows imports into the shared packages'
        // TypeScript sources, so those files must resolve from the client's
        // program — which is only true if the mapping reaches both TypeScript
        // and Vite from one place.
        // Targets are *directories*, not files. SvelteKit only synthesises the
        // `name/*` path mapping when the alias value has no file extension, so
        // pointing at `index.ts` would silently break every subpath import.
        '@starter/schemas': '../../../packages/shared/schemas/src',
        '@starter/logger': '../../../packages/shared/logger/src',
        '@starter/utils': '../../../packages/shared/utils/src',
        '@starter/frontend-services': '../../../packages/frontend/services/src',
        '@starter/ui': '../../../packages/frontend/ui/src',
      },
    }) as PluginOption,
  ],

  server: {
    port: PORT.client,
    strictPort: true,
    host: DEV_HOST,
    proxy: {
      // Proxying in dev means the browser sees a same-origin API, so session
      // cookies behave exactly as they will in production. Without this, a
      // session that works locally breaks the moment the API is on another
      // origin — a class of bug that is tedious to diagnose later.
      '/api': {
        target: `http://${DEV_HOST}:${PORT.api}`,
        changeOrigin: false,
        secure: false,
      },
    },
  },

  // The preview server needs the same proxy as the dev server, and it is a
  // separate block because `vite preview` only serves static files — configure
  // `server.proxy` alone and every `/api` request from a previewed build returns
  // 404 from the static handler. The symptom is a sign-in form that reports
  // "The request failed" against a Worker that is running and healthy.
  preview: {
    port: PORT.client,
    strictPort: true,
    host: DEV_HOST,
    proxy: {
      '/api': {
        target: `http://${DEV_HOST}:${PORT.api}`,
        changeOrigin: false,
        secure: false,
      },
    },
  },

  define: {
    // Nothing in `src/` reads this today; it is defined so a consumer that wants
    // to branch on "am I bundled for a native shell" has a build-time constant
    // rather than guessing from `navigator.userAgent`. Replace
    // `check:bundle`'s assertion that no `@tauri-apps/*` import survives a native
    // build if that day comes.
    __TAURI_NATIVE_BUILD__: JSON.stringify(isNativeBuild),
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
