import { createRunnerGrantService } from '#lib/server/runner_grants.ts';
import type { RequestHandler } from './$types';

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Internal runner policy: Google service-account JWT for grant minting; signed method/object token for R2 transfer. */
export const POST: RequestHandler = async ({ request, params, platform, url }) => {
  if (platform?.STARTER_BACKEND_PROFILE !== 'supabase') {
    return response(503, { error: 'runner_grants_disabled' });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return response(400, { error: 'invalid_request' });
  }
  const report = body as Record<string, unknown> | null;
  if (
    typeof body !== 'object' ||
    body === null ||
    !report ||
    ![2, 3].includes(Object.keys(report).length) ||
    typeof report.attemptId !== 'string' ||
    typeof report.executionName !== 'string' ||
    (Object.keys(report).length === 3 &&
      (typeof report.processorExitCode !== 'number' || !Number.isInteger(report.processorExitCode)))
  ) {
    return response(400, { error: 'invalid_request' });
  }
  try {
    const service = createRunnerGrantService(platform, url.origin);
    if (typeof report?.processorExitCode === 'number') {
      const recorded = await service.reportProcessorFailure(
        request,
        params.id,
        report.attemptId as string,
        report.executionName as string,
        report.processorExitCode,
      );
      return response(recorded ? 204 : 409, recorded ? null : { error: 'runner_attempt_fenced' });
    }
    return response(
      200,
      await service.issue(
        request,
        params.id,
        report?.attemptId as string,
        report?.executionName as string,
      ),
    );
  } catch (error) {
    const waiting = error instanceof Error && error.message === 'Runner attempt is not active.';
    const configuration =
      error instanceof Error &&
      error.message.startsWith('Runner grant configuration is incomplete:');
    if (configuration) {
      return response(503, { error: 'runner_grants_unavailable' });
    }
    if (waiting) {
      return response(409, { error: 'runner_attempt_pending' });
    }
    return response(401, { error: 'runner_identity_refused' });
  }
};

const transfer: RequestHandler = async ({ request, params, platform }) => {
  if (platform?.STARTER_BACKEND_PROFILE !== 'supabase') {
    return response(503, { error: 'runner_grants_disabled' });
  }
  try {
    const service = createRunnerGrantService(platform, new URL(request.url).origin);
    const result = await service.transfer(request, params.id, request.method as 'GET' | 'PUT');
    return result;
  } catch {
    return response(403, { error: 'object_grant_refused' });
  }
};

export const GET = transfer;
export const PUT = transfer;
