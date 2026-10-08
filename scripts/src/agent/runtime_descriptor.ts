import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export type RuntimeProfile = 'dev' | 'built' | 'full';

export interface RuntimeDescriptor {
  schemaVersion: 1;
  runId: string;
  checkout: string;
  profile: RuntimeProfile;
  origins: Record<string, string>;
  browserExecutable: string;
  buildIdentity: string | null;
  identityVerified: boolean;
  artifactRoot: string;
  logRoot: string;
}

export interface VerifiedRuntimeIdentity {
  verified: true;
  runId: string;
  origin: string;
  service: 'web';
}

const DESCRIPTOR_KEYS = new Set([
  'schemaVersion',
  'runId',
  'checkout',
  'profile',
  'origins',
  'browserExecutable',
  'buildIdentity',
  'identityVerified',
  'artifactRoot',
  'logRoot',
]);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const ORIGIN_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Runtime descriptor ${label} must be a non-empty string.`);
  }
  return value;
};

const validateOrigin = (value: unknown, label: string): string => {
  const text = nonEmptyString(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Runtime descriptor ${label} must be a valid local HTTP origin.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `Runtime descriptor ${label} must be a credential-free loopback origin with an explicit port.`,
    );
  }
  return url.origin;
};

const validateDescriptor = (value: unknown): RuntimeDescriptor => {
  if (!record(value)) {
    throw new Error('Runtime descriptor must be a JSON object.');
  }
  const unknown = Object.keys(value).filter((key) => !DESCRIPTOR_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Runtime descriptor contains unknown key(s): ${unknown.join(', ')}.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Runtime descriptor schemaVersion must be 1.');
  }
  if (typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) {
    throw new Error('Runtime descriptor runId is invalid.');
  }
  const checkout = nonEmptyString(value.checkout, 'checkout');
  if (!isAbsolute(checkout)) {
    throw new Error('Runtime descriptor checkout must be absolute.');
  }
  if (value.profile !== 'dev' && value.profile !== 'built' && value.profile !== 'full') {
    throw new Error('Runtime descriptor profile must be dev, built, or full.');
  }
  if (!record(value.origins) || Object.keys(value.origins).length === 0) {
    throw new Error('Runtime descriptor origins must be a non-empty object.');
  }
  const origins: Record<string, string> = {};
  for (const [name, origin] of Object.entries(value.origins)) {
    if (!ORIGIN_ID.test(name)) {
      throw new Error(`Runtime descriptor origin id ${JSON.stringify(name)} is invalid.`);
    }
    origins[name] = validateOrigin(origin, `origins.${name}`);
  }
  if (origins.web === undefined) {
    throw new Error('Runtime descriptor must declare origins.web.');
  }
  const browserExecutable = nonEmptyString(value.browserExecutable, 'browserExecutable');
  if (!isAbsolute(browserExecutable)) {
    throw new Error('Runtime descriptor browserExecutable must be absolute.');
  }
  if (
    value.buildIdentity !== null &&
    (typeof value.buildIdentity !== 'string' || !HASH.test(value.buildIdentity))
  ) {
    throw new Error('Runtime descriptor buildIdentity must be a SHA-256 hash or null.');
  }
  if (value.identityVerified !== true) {
    throw new Error(
      'Runtime descriptor cannot be persisted before identity verification succeeds.',
    );
  }
  const artifactRoot = nonEmptyString(value.artifactRoot, 'artifactRoot');
  const logRoot = nonEmptyString(value.logRoot, 'logRoot');
  if (!isAbsolute(artifactRoot) || !isAbsolute(logRoot)) {
    throw new Error('Runtime descriptor artifactRoot and logRoot must be absolute.');
  }
  return {
    schemaVersion: 1,
    runId: value.runId,
    checkout,
    profile: value.profile,
    origins,
    browserExecutable,
    buildIdentity: value.buildIdentity,
    identityVerified: true,
    artifactRoot,
    logRoot,
  };
};

export const writeRuntimeDescriptor = async (
  path: string,
  descriptor: RuntimeDescriptor,
): Promise<void> => {
  const verified = validateDescriptor(descriptor);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(verified, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await import('node:fs/promises').then(({ unlink }) => unlink(temporary).catch(() => {}));
    throw error;
  }
};

export const readRuntimeDescriptor = async (path: string): Promise<RuntimeDescriptor> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read runtime descriptor at ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return validateDescriptor(parsed);
};

export const verifyRuntimeIdentity = async (
  descriptor: RuntimeDescriptor,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<VerifiedRuntimeIdentity> => {
  const verifiedDescriptor = validateDescriptor(descriptor);
  const origin = verifiedDescriptor.origins.web;
  const url = new URL('/api/health', origin);
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`Runtime identity probe failed for ${origin}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`Runtime identity probe returned HTTP ${response.status}.`);
  }
  const text = await readBoundedResponseText(response, 16 * 1024);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`Runtime identity response was not JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!record(body) || body.service !== 'web' || body.testRunId !== verifiedDescriptor.runId) {
    throw new Error(
      `Runtime identity mismatch at ${origin}: expected web run ${verifiedDescriptor.runId}.`,
    );
  }
  if (body.baseUrl !== origin) {
    throw new Error(
      `Runtime origin mismatch: expected ${origin}, received ${String(body.baseUrl)}.`,
    );
  }
  return { verified: true, runId: verifiedDescriptor.runId, origin, service: 'web' };
};

const readBoundedResponseText = async (response: Response, limit: number): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new Error(`Runtime identity response exceeded ${limit / 1024} KiB.`);
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`Runtime identity response exceeded ${limit / 1024} KiB.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};
