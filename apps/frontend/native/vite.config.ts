// apps/frontend/native/vite.config.ts
//
// One SvelteKit app, one build target: static files for the Tauri shell to bundle.
//
// SvelteKit 3 takes its whole configuration inline, exactly as the web app does in
// `apps/frontend/client/vite.config.ts` — there is no `svelte.config.js` in either
// project. The adapter is `@sveltejs/adapter-static` and nothing else: the shell
// needs files on disk, not a Worker.
//
// **Why this app is static and the web app is not**
// ------------------------------------------------
// The web Worker renders HTML per request, because the page it renders depends on
// a session cookie only the server can read. The native app has the opposite
// shape: a bearer token in the front end, an API on another origin, and a shell
// that loads local files. There is nothing for a server to render *per request*,
// so it is prerendered once at build time and shipped inside the binary. Keeping
// SSR in the web app is not a preference that lost to this one; the two solve
// different problems and both keep the answer they are right for.
//
// `fallback: 'index.html'` is what makes an unknown deep link work, and it is the
// file Tauri itself looks for last. `tauri`'s asset resolver tries `<path>`,
// then `<path>.html`, then `<path>/index.html`, then `index.html` — so the
// prerendered `/notes` is found as `notes.html`, and a path nothing prerendered
// falls through to this file. The fallback is therefore not a rewrite rule
// invented here; it is the last entry in the shell's own lookup.
//
// `strict: true` is the load-bearing option: it turns "a route could not be
// prerendered" into a failed build. Without it the adapter writes a shell and
// reports success, and the missing screen is discovered by a user opening the app.
//
// The adapter reports that it overwrote `build/index.html` with the fallback page.
// That is expected rather than a conflict: the prerendered root *is* the SPA
// shell, and the fallback is what the shell serves for a path with no page of its
// own.

import { assertNativeCsp, DEV_API_HOST_ENV, resolveApiOrigin } from '@starter/schemas/native';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { NATIVE_DEV_HOST, NATIVE_DEV_PORT } from './dev_ports.ts';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // SvelteKit sync loads this config too. Validate when serving/building, so
  // type generation does not require a deployment origin.
  const validateOrigin = (): void => {
    const dev = command === 'serve';
    const apiOrigin = resolveApiOrigin({
      raw: env.VITE_NATIVE_API_ORIGIN,
      dev,
      // Only ever read for a dev build. `resolveApiOrigin` refuses the pair in a
      // packaged one, so a stale `VITE_NATIVE_DEV_API_HOST` cannot bake a LAN
      // address into a release bundle.
      devHost: dev ? env[DEV_API_HOST_ENV] : undefined,
    });
    if (process.env.TAURI_CONFIG !== undefined) {
      const config = JSON.parse(process.env.TAURI_CONFIG) as {
        app?: { security?: { csp?: string; devCsp?: string } };
      };
      const security = config.app?.security;
      const supabaseUrl = env.VITE_NATIVE_SUPABASE_URL;
      const additionalOrigins = env.VITE_NATIVE_AUTH_PROFILE === 'supabase' && supabaseUrl !== undefined
        ? [new URL(supabaseUrl).origin]
        : [];
      assertNativeCsp(security?.csp ?? '', apiOrigin, additionalOrigins);
      assertNativeCsp(security?.devCsp ?? '', apiOrigin, additionalOrigins);
    }
  };
  return {
    plugins: [
      {
        name: 'native-api-policy',
        buildStart: validateOrigin,
        configureServer: validateOrigin,
      },
      tailwindcss(),
      sveltekit({
        preprocess: [vitePreprocess()],
        adapter: adapter({
          pages: 'build',
          assets: 'build',
          // Deep links (`/notes`) and any path the prerender pass did not produce.
          fallback: 'index.html',
          // A Tauri bundle is compressed as an archive by the installer; a
          // precompressed sidecar in the frontend directory doubles what ships for a
          // few percent of download time.
          precompress: false,
          // See the header: a route that cannot be prerendered fails the build.
          strict: true,
        }),
      }),
    ],

    // The port `src-tauri/tauri.conf.json` names as `devUrl`. `strictPort` so a
    // busy port fails loudly here instead of producing a shell pointed at another
    // project's dev server.
    server: {
      port: NATIVE_DEV_PORT,
      strictPort: true,
      host: NATIVE_DEV_HOST,
    },

    build: {
      target: 'es2022',
      // No source maps in the shipped bundle. They name internal paths of a
      // template, and the shell has no error-reporting sink to receive them.
      sourcemap: false,
    },
  };
});
