// apps/frontend/client/vite.config.ts
//
// One SvelteKit app, one build target: a browser SPA.
//
// This configuration used to switch between a browser bundle and a native
// bundle on a `TAURI_NATIVE_BUILD` environment variable, and to alias
// `@tauri-apps/*` to a throwing stub for the browser case. There is one target
// now, so there is no switch to set and no stub to substitute: a browser build
// that still imports a native package is a defect, and `check:bundle` fails it
// rather than papering over it here.
//
// SvelteKit 3 takes its whole configuration inline; there is no
// svelte.config.js.
//
// No `alias` block on purpose: SvelteKit deprecated custom aliases in favour of
// subpath imports. `$lib/...` is built in, and everything outside this app is
// reached through its published package name (`@starter/ui`,
// `@starter/schemas/notes`), which is also what the workspace boundary guard
// reads. An alias map would let a file name a package the guard cannot see.

import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { API_DEV_PORT, CLIENT_DEV_PORT, DEV_HOST } from './dev_ports.ts';

// One authority for both ports: see dev_ports.ts.
const PORT = {
  client: CLIENT_DEV_PORT,
  api: API_DEV_PORT,
} as const;

export default defineConfig({
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

  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
