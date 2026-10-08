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

import type { VerifiedIdentity } from '@starter/auth/supabase';
import type { Container } from '#lib/server/container.ts';
import type { RequestContext, RequestUser } from '#lib/server/request_context.ts';
import type { ApplicationServices } from '#lib/server/supabase_context.ts';

declare global {
  /**
   * The Worker's bindings, as `cloudflare:workers` types them.
   *
   * `import { env } from 'cloudflare:workers'` is typed `Cloudflare.Env`, and
   * `Cloudflare.Env` is an empty interface by default — so without this
   * declaration every binding access is an error under `noImplicitAny` and an
   * unconstrained `any` under `skipLibCheck`, and `Supabase query type-checks` type-checks
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
      readonly SUPABASE_URL?: string;
      readonly SUPABASE_ANON_KEY?: string;
      readonly SUPABASE_SERVICE_ROLE_KEY?: string;
      readonly SUPABASE_MAIL_URL?: string;
      readonly RUNNER_GRANT_SECRET?: string;
      readonly GOOGLE_RUNNER_AUDIENCE?: string;
      readonly GOOGLE_RUNNER_SERVICE_ACCOUNT?: string;
      readonly GOOGLE_RUNNER_SUBJECT?: string;
      readonly DEPLOYMENT_ENV?: string;
      readonly APP_ORIGIN?: string;
      readonly TEST_RUN_ID?: string;
      readonly TRUSTED_PROXIES?: string;
      readonly RESEND_API_KEY?: string;
      readonly MAIL_FROM?: string;
      readonly LOG_LEVEL?: string;
      readonly RELEASE?: string;
      readonly JOBS_PROFILE?: string;
      // Cross-Worker Workflow binding into the jobs Worker, and the private artifact
      // bucket it shares with it. Both are absent in an environment whose jobs
      // profile is disabled, which is the shipped default; see
      // `src/lib/server/container.ts` for how their absence is answered.
      readonly ENCODE_WORKFLOW?: {
        // `get` is declared because `createWorkflowDispatchPort` calls it: when the
        // provider answers `instance.already_exists`, the port asks the existing
        // instance for its status rather than assuming success. Leaving `get` out of
        // this view made the two type views of the same binding disagree — the file's
        // own header says a mismatch should be a compile error wherever it is used,
        // and here nothing used the stale one.
        create(options: { id: string; params?: unknown }): Promise<{ id: string }>;
        get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
      };
      readonly MEDIA?: R2Bucket;
    }
  }

  namespace App {
    interface Platform {
      readonly SUPABASE_URL?: string;
      readonly SUPABASE_ANON_KEY?: string;
      readonly SUPABASE_SERVICE_ROLE_KEY?: string;
      readonly SUPABASE_MAIL_URL?: string;
      readonly RUNNER_GRANT_SECRET?: string;
      readonly GOOGLE_RUNNER_AUDIENCE?: string;
      readonly GOOGLE_RUNNER_SERVICE_ACCOUNT?: string;
      readonly GOOGLE_RUNNER_SUBJECT?: string;
      readonly DEPLOYMENT_ENV?: string;
      readonly APP_ORIGIN?: string;
      readonly TEST_RUN_ID?: string;
      readonly TRUSTED_PROXIES?: string;
      readonly RESEND_API_KEY?: string;
      readonly MAIL_FROM?: string;
      readonly LOG_LEVEL?: string;
      readonly RELEASE?: string;
      readonly JOBS_PROFILE?: string;
      readonly ENCODE_WORKFLOW?: {
        // `get` is declared because `createWorkflowDispatchPort` calls it: when the
        // provider answers `instance.already_exists`, the port asks the existing
        // instance for its status rather than assuming success. Leaving `get` out of
        // this view made the two type views of the same binding disagree — the file's
        // own header says a mismatch should be a compile error wherever it is used,
        // and here nothing used the stale one.
        create(options: { id: string; params?: unknown }): Promise<{ id: string }>;
        get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
      };
      readonly MEDIA?: R2Bucket;
    }

    interface Locals {
      /**
       * Bindings, the Drizzle handle and the Supabase Auth instance, built once per
       * binding set and origin. Never serialized into page data.
       */
      container: Container;
      /**
       * The verified caller, or null. Resolved from the session on every request
       * and never cached beyond it.
       *
       * A convenience alias of `context.user`. A route reads `context` for the
       * trace id and the record destination, so it has no reason to reach for a
       * second field that can only ever disagree.
       */
      user: RequestUser | null;
      /**
       * The request context, built once by the composition root.
       *
       * This is the *only* per-request identity a route should read: the session
       * was resolved once, in `handle`, and a route that resolved it again would be
       * a second differently authenticated path to the same user.
       */
      context: RequestContext;
      supabaseIdentity: VerifiedIdentity | null;
      applicationServices: ApplicationServices | null;
    }
  }
}

// `App.DisableSsrAuth` is deliberately *not* declared. The global `ssr = false` this
// replaced disabled the server renderer for the whole application, which is why the
// landing page was an empty shell. This one is server-rendered: it reads nothing but
// static content, and it is what proves the Worker's HTML path works without a
// proxy in front of it.
