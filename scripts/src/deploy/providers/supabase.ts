import { REPO_ROOT } from '../../shared/paths.ts';
import { runBoundedSync } from '../../shared/run_bounded.ts';
import { resolveWorkspaceBin } from '../../shared/tools.ts';
import type { ResolvedTarget } from '../target.ts';

const MANAGEMENT_API = 'https://api.supabase.com/v1';
const RESPONSE_LIMIT = 512_000;
export type SupabaseRequest = (url: string, init: RequestInit) => Promise<Response>;

const managementRequest = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  method: 'GET' | 'PATCH';
  fetcher?: SupabaseRequest;
}): Promise<Record<string, unknown>> => {
  if (!options.accessToken || options.accessToken.length > 8192) {
    throw new Error('Supabase access token is missing or invalid.');
  }
  const response = await (options.fetcher ?? ((url, init) => fetch(url, init)))(
    `${MANAGEMENT_API}/projects/${encodeURIComponent(options.target.supabase.projectRef)}/config/auth`,
    {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        ...(options.method === 'PATCH' ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.method === 'PATCH'
        ? {
            body: JSON.stringify({
              site_url: options.target.origin,
              uri_allow_list: options.target.supabase.nativeRedirectAllowlist.join(','),
            }),
          }
        : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error('Supabase Management API response exceeded its byte budget.');
      }
      chunks.push(value);
    }
  }
  if (!response.ok) {
    throw new Error(`Supabase Management API request failed (${response.status}).`);
  }
  if (total === 0) {
    return {};
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error();
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new Error('Supabase Management API returned invalid JSON.');
  }
};

export const inspectSupabaseAuthConfig = (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: SupabaseRequest;
}) => managementRequest({ ...options, method: 'GET' });

/** Explicit authenticated apply of hosted callback configuration; never part of plan or preflight. */
export const applySupabaseAuthConfig = (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: SupabaseRequest;
}) => managementRequest({ ...options, method: 'PATCH' });

const PACKAGE = 'packages/backend/database';

/** Supabase CLI is resolved from the workspace package that pins it. */
export const supabaseBin = (root = REPO_ROOT): string | null =>
  resolveWorkspaceBin('supabase', [PACKAGE], root);

export const supabaseMigrationArgs = (
  target: ResolvedTarget,
  operation: 'list' | 'push',
): string[] => {
  const identity = ['--project-ref', target.supabase.projectRef];
  return operation === 'list'
    ? ['migration', 'list', ...identity, '--workdir', REPO_ROOT]
    : ['db', 'push', ...identity, '--include-all', '--workdir', REPO_ROOT];
};

export const supabaseLocalMigrationArgs = (): string[] => [
  'migration',
  'up',
  '--local',
  '--workdir',
  REPO_ROOT,
];
export const supabaseLocalStatusArgs = (): string[] => [
  'migration',
  'list',
  '--local',
  '--workdir',
  REPO_ROOT,
];

export const runSupabaseLocalMigration = (options: { root?: string } = {}) => {
  const root = options.root ?? REPO_ROOT;
  const binary = supabaseBin(root);
  if (binary === null) {
    return { code: 1, stdout: '', stderr: 'Pinned Supabase CLI is not installed.' };
  }
  return runBoundedSync({
    command: binary,
    args: supabaseLocalMigrationArgs(),
    cwd: root,
    timeoutMs: 15 * 60_000,
    maxBytes: 2 * 1024 * 1024,
  });
};

export const runSupabaseLocalStatus = (options: { root?: string } = {}) => {
  const root = options.root ?? REPO_ROOT;
  const binary = supabaseBin(root);
  if (binary === null) {
    return { code: 1, stdout: '', stderr: 'Pinned Supabase CLI is not installed.' };
  }
  return runBoundedSync({
    command: binary,
    args: supabaseLocalStatusArgs(),
    cwd: root,
    timeoutMs: 60_000,
    maxBytes: 512 * 1024,
  });
};

/** A migration is never allowed to select a project from local Supabase link state. */
export const runSupabaseMigration = (
  target: ResolvedTarget,
  operation: 'list' | 'push',
  options: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    binary?: string;
    run?: typeof runBoundedSync;
  } = {},
): { code: number; stdout: string; stderr: string } => {
  const root = options.root ?? REPO_ROOT;
  const binary = options.binary ?? supabaseBin(root);
  if (binary === null) {
    return { code: 1, stdout: '', stderr: 'Pinned Supabase CLI is not installed.' };
  }
  const args = supabaseMigrationArgs(target, operation);
  const result = (options.run ?? runBoundedSync)({
    command: binary,
    args,
    cwd: root,
    timeoutMs: 15 * 60_000,
    maxBytes: 2 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  return {
    code: result.code,
    stdout: result.stdout.slice(0, 64_000),
    stderr: redactSupabaseOutput(result.stderr).slice(0, 8_000),
  };
};

export const redactSupabaseOutput = (value: string): string =>
  value
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/(SUPABASE_ACCESS_TOKEN\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(service_role[^\n]{0,20})/gi, '[REDACTED]');
