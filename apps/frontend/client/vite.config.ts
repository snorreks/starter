// apps/frontend/client/vite.config.ts
//
// One SvelteKit app, one build target: a Cloudflare Worker plus its static assets.
//
// SvelteKit 3 takes its whole configuration inline; there is no svelte.config.js.
// The adapter is `@sveltejs/adapter-cloudflare`, and it is the *adapter* that
// integrates with Cloudflare — not `@cloudflare/vite-plugin`. That distinction is
// deliberate and is the reason the built output is trustworthy: the adapter owns
// the Wrangler contract (`main`, `assets.directory`, `assets.binding`), emits
// `.svelte-kit/cloudflare/_worker.js`, and provides `cloudflare:workers` in dev
// through wrangler's `getPlatformProxy`, reading this project's own
// `wrangler.jsonc`. A Vite plugin would own the build instead, and a
// build-only integration is exactly the thing that cannot be verified without
// deploying. See docs/architecture.md for the version set and why each pin exists.
//
// **There is no `server.proxy` and no `preview.proxy`.** That is the whole point
// of the migration. The proxy existed because the browser ran on one port and the
// API on another; now `vite dev` and `vite preview` both serve the pages and
// `/api/*` from a single origin, so a session cookie behaves identically in
// development and in production — the property the proxy was there to fake, now
// obtained for real. A proxy left in place would hide exactly the class of bug
// this change is supposed to make impossible.
//
// No `alias` block for the workspace packages beyond what SvelteKit needs: they
// resolve through `node_modules`, because each package's `exports` points at its
// TypeScript source. `#lib` is the one alias, because SvelteKit 3 dropped the
// built-in `$lib` alias and subpath imports are the supported replacement; it
// appears here because SvelteKit turns `alias` entries into the generated
// tsconfig's `paths`, so TypeScript and the bundler resolve the same specifier
// from one place.

import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { type PluginOption, defineConfig } from 'vite';
import { CLIENT_DEV_PORT, DEV_HOST } from './dev_ports.ts';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: [vitePreprocess()],
      adapter: adapter({
        // Read `wrangler.jsonc` from this project root, which is the adapter's
        // default. Stated because the file it reads is the deployment contract,
        // and pointing it elsewhere would silently build against different
        // bindings than the ones that will be deployed.
        config: 'wrangler.jsonc',
        // No `routes`: that option only applies to Cloudflare Pages, and this
        // project deploys to Workers. Left unset rather than set to its default so
        // the distinction is visible.
        fallback: 'plaintext',
      }),
      // SvelteKit 3 removed the built-in `$lib` alias. The supported replacement
      // is a subpath import, and this is what makes it work: SvelteKit turns
      // `alias` entries into the generated tsconfig's `paths`, so TypeScript and
      // the bundler resolve the same specifier from one declaration.
      //
      // `alias` is deprecated in favour of a `package.json` `imports` map, and that
      // was tried first: `"imports": { "#lib/*": "./src/lib/*" }` with
      // `resolvePackageJsonImports` set resolves in Vite and Node and then reports
      // `Cannot find module '#lib/…'` for every import in the program under
      // `svelte-check`. A specifier the bundler understands and the type checker
      // does not is the worst of the three outcomes — the build succeeds and the
      // types are wrong — so the deprecated key stays, and this is the note that
      // says why until the two agree.
      alias: {
        '#lib': 'src/lib',
      },
    }) as PluginOption,
  ],

  server: {
    port: CLIENT_DEV_PORT,
    strictPort: true,
    host: DEV_HOST,
  },

  // `vite preview` serves the built app through the same adapter-provided
  // `cloudflare:workers` emulation, so it needs the host and port and nothing
  // else. There is no API to forward to: the preview server *is* the API.
  preview: {
    port: CLIENT_DEV_PORT,
    strictPort: true,
    host: DEV_HOST,
  },

  build: {
    target: 'es2022',
    // A production Worker must not publish its own source. The sourcemaps are
    // uploaded for error reporting, not served as assets.
    sourcemap: 'hidden',
  },
});
