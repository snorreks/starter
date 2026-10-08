import * as v from 'valibot';
import { jsonError, readJsonBody } from '#lib/server/http.ts';
import { createRunnerGrantService } from '#lib/server/runner_grants.ts';
import type { RequestHandler } from './$types';

const GrantRequestSchema = v.union([
  v.strictObject({ attemptId: v.string(), executionName: v.string() }),
  v.strictObject({
    attemptId: v.string(),
    executionName: v.string(),
    processorExitCode: v.pipe(v.number(), v.integer()),
  }),
]);
const NO_STORE = { 'cache-control': 'no-store' };

/** Internal runner policy: Google service-account JWT for grant minting; signed method/object token for R2 transfer. */
export const POST: RequestHandler = async ({ request, params, platform, url }) => {
  const parsed = await readJsonBody(request, GrantRequestSchema, {
    maxBytes: 4096,
    invalidStatus: 400,
  });
  if (!parsed.ok) {
    return parsed.response;
  }
  if (platform?.JOBS_PROFILE !== 'encode') {
    return jsonError(503, 'runner_grants_disabled', 'Runner grants are disabled.');
  }
  const report = parsed.value;
  try {
    const service = createRunnerGrantService(platform, url.origin);
    if ('processorExitCode' in report) {
      const recorded = await service.reportProcessorFailure(
        request,
        params.id,
        report.attemptId,
        report.executionName,
        report.processorExitCode,
      );
      return recorded
        ? new Response(null, { status: 204, headers: NO_STORE })
        : jsonError(409, 'runner_attempt_fenced', 'The runner attempt is no longer active.');
    }
    return Response.json(
      await service.issue(request, params.id, report.attemptId, report.executionName),
      { headers: NO_STORE },
    );
  } catch (error) {
    const waiting = error instanceof Error && error.message === 'Runner attempt is not active.';
    const configuration =
      error instanceof Error &&
      error.message.startsWith('Runner grant configuration is incomplete:');
    if (configuration) {
      return jsonError(503, 'runner_grants_unavailable', 'Runner grants are not configured.');
    }
    if (waiting) {
      return jsonError(409, 'runner_attempt_pending', 'The runner attempt is not active yet.');
    }
    return jsonError(401, 'runner_identity_refused', 'The runner identity was refused.');
  }
};

const transfer: RequestHandler = async ({ request, params, platform }) => {
  if (platform?.JOBS_PROFILE !== 'encode') {
    return jsonError(503, 'runner_grants_disabled', 'Runner grants are disabled.');
  }
  try {
    const service = createRunnerGrantService(platform, new URL(request.url).origin);
    const result = await service.transfer(request, params.id, request.method as 'GET' | 'PUT');
    return result;
  } catch {
    return jsonError(403, 'object_grant_refused', 'The object grant was refused.');
  }
};

export const GET = transfer;
export const PUT = transfer;

export const DELETE = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use GET, PUT or POST here.');
export const PATCH = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use GET, PUT or POST here.');
