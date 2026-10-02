// apps/frontend/client/src/routes/api/health/+server.ts
//
// `/api/health` — liveness, plus the effective (non-secret) configuration.
//
// Two readers, and they need different things. An operator needs to answer "what
// is this deployment actually set to" without reading wrangler config and
// guessing. A test harness needs to prove it is talking to *its* Worker.
//
// `testRunId` exists for the second one, and the reason is worth stating: a
// harness that starts a Worker on a port has to be able to prove the process
// answering is the one it started. A stale listener on the same port answers
// `/api/health` just as readily, and a readiness probe that only checks for a 200
// will run a whole suite against the wrong process — passing, and proving
// nothing. Echoing an identifier the harness supplied turns that into a real
// check.
//
// Nothing here is a secret. There is a test in the integration lane that fails if
// the serialized body ever contains a word like "secret" or "token", precisely
// because an endpoint that reports configuration is one somebody eventually adds
// a credential to.

import { json } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
  const { container } = locals;

  return json(200, {
    ok: true,
    service: 'web',
    environment: container.environment,
    // The origin this container answers on. Non-secret by construction: it is the
    // public URL, and printing it is what makes a wrong `BETTER_AUTH_URL`
    // diagnosable without a deploy.
    baseUrl: container.baseUrl,
    authRateLimitMax: container.env.AUTH_RATE_LIMIT_MAX ?? '10 (default)',
    trustedOriginCount:
      container.env.TRUSTED_ORIGINS?.split(',').filter((o) => o.trim() !== '').length ?? 0,
    // Which implementation is in use, and whether the limiter is enforced at all.
    // "mode" and a budget are what an operator needs; the API key is not here and
    // must never be, so its presence is reported as a boolean-by-omission.
    mail: { mode: container.mail.mode, from: container.mail.from },
    rateLimit: {
      storage: 'd1',
      max: container.env.AUTH_RATE_LIMIT_MAX ?? '10 (default)',
    },
    ...(container.env.TEST_RUN_ID === undefined ? {} : { testRunId: container.env.TEST_RUN_ID }),
  });
};
