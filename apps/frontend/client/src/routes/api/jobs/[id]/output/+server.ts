import { jsonError, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const byteRange = (
  header: string | null,
  size: number,
): { offset: number; length: number } | null | 'invalid' => {
  if (header === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size < 1) {
    return 'invalid';
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      return 'invalid';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return 'invalid';
  }
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
};

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const services = locals.applicationServices;
  if (!locals.user || !services || services.identity.user.id !== locals.user.id) {
    return unauthorized();
  }
  if (locals.container.jobsProfile !== 'encode') {
    return jsonError(
      503,
      'jobs_profile_disabled',
      'Compute is explicitly disabled for this deployment.',
    );
  }
  const job = await services.jobs.getForOwner(params.id);
  if (!job) {
    return jsonError(404, 'not_found', 'That job does not exist.');
  }
  if (!job.outputAvailable) {
    return jsonError(409, 'output_not_ready', 'The job has not produced an output.');
  }
  const artifact = await services.jobs.outputForOwner(params.id);
  if (!artifact) {
    return jsonError(410, 'output_expired', 'The output is no longer available.');
  }
  const bucket = locals.container.env.MEDIA;
  if (!bucket) {
    return jsonError(503, 'output_unavailable', 'The private artifact store is not configured.');
  }
  const metadata = await bucket.head(artifact.key);
  if (!metadata) {
    return jsonError(410, 'output_expired', 'The output is no longer available.');
  }
  const range = byteRange(request.headers.get('range'), metadata.size);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${metadata.size}` },
    });
  }
  const object = await bucket.get(artifact.key, range ? { range } : undefined);
  if (!object) {
    return jsonError(410, 'output_expired', 'The output is no longer available.');
  }
  const headers = new Headers({
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-type': object.httpMetadata?.contentType ?? 'video/mp4',
    'content-length': String(range?.length ?? metadata.size),
    'x-output-sha256': metadata.customMetadata?.sha256 ?? '',
    'x-output-duration-ms': metadata.customMetadata?.durationMs ?? '',
  });
  if (range) {
    headers.set(
      'content-range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
    );
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
};

const methodNotAllowed = (): Response => jsonError(405, 'method_not_allowed', 'Use GET here.');
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
