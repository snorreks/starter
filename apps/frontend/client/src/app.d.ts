// apps/frontend/client/src/app.d.ts
//
// The application's own types, as SvelteKit sees them.
//
// Two declarations, both load-bearing:
//
//   `App.Platform` is the Worker's binding set. `@sveltejs/adapter-cloudflare`
//   hands it to the framework on every request, so this is the only place the
//   application receives its configuration — there is no second source and no
//   process-level environment read that could disagree with it.
//
//   `App.Locals` is what the composition root publishes to the rest of the
//   request. It is per-request by construction: `handle` builds it from the
//   `Request` in hand and the framework discards it when the response is sent.
//   That is why nothing request-scoped may live in a module variable.

import type { Container, RequestUser } from '#lib/server/container.ts';

declare global {
  /**
   * The Worker's bindings, as `cloudflare:workers` types them.
   *
   * `import { env } from 'cloudflare:workers'` is typed `Cloudflare.Env`, and
   * `Cloudflare.Env` is an empty interface by default — so without this
   * declaration every binding access is an error under `noImplicitAny` and an
   * unconstrained `any` under `skipLibCheck`, and `DB.prepare(...)` type-checks
   * against nothing.
   *
   * The same fields are declared a second time on `App.Platform` below. That is
   * duplication and it is deliberate: the two describe different surfaces. This one
   * is what the adapter's generated Worker and the `cloudflare:workers` import are
   * checked against, and it is what `wrangler types` would generate. `App.Platform`
   * is what SvelteKit hands a `RequestEvent`, and it is what the application reads.
   * One source of truth for the Worker binding set is `wrangler.jsonc`; this file
   * and `App.Platform` are the two type views of it, and a mismatch between them is
   * a compile error at whichever call site uses the other.
   */
  namespace Cloudflare {
    interface Env {
      readonly DB: D1Database;
      readonly DEPLOYMENT_ENV?: string;
      readonly BETTER_AUTH_URL?: string;
      readonly BETTER_AUTH_SECRET?: string;
      readonly TRUSTED_ORIGINS?: string;
      readonly TEST_RUN_ID?: string;
      readonly AUTH_RATE_LIMIT_MAX?: string;
      readonly LOG_LEVEL?: string;
      readonly RELEASE?: string;
    }
  }

  namespace App {
    interface Platform {
      readonly DB: D1Database;
      readonly DEPLOYMENT_ENV?: string;
      readonly BETTER_AUTH_URL?: string;
      readonly BETTER_AUTH_SECRET?: string;
      readonly TRUSTED_ORIGINS?: string;
      readonly TEST_RUN_ID?: string;
      readonly AUTH_RATE_LIMIT_MAX?: string;
      readonly LOG_LEVEL?: string;
      readonly RELEASE?: string;
    }

    interface Locals {
      /**
       * Bindings, the Drizzle handle and the Better Auth instance, built once per
       * binding set and origin. Never serialized into page data.
       */
      container: Container;
      /**
       * The verified caller, or null. Resolved from the session on every request
       * and never cached beyond it.
       */
      user: RequestUser | null;
    }
  }
}

// `App.DisableSsrAuth` is deliberately *not* declared. The global `ssr = false` this
// replaced disabled the server renderer for the whole application, which is why the
// landing page was an empty shell. This one is server-rendered: it reads nothing but
// static content, and it is what proves the Worker's HTML path works without a
// proxy in front of it.
