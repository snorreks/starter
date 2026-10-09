import { supabaseBin } from '../deploy/providers/supabase.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBoundedSync } from '../shared/run_bounded.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const NOTES = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    owner_id: USER_ID,
    title: 'Welcome',
    body: 'This note is synthetic local seed data.',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    owner_id: USER_ID,
    title: 'Delete me',
    body: 'This synthetic note exists for local delete journeys.',
  },
] as const;

export type SeedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const parseStatus = (output: string): { apiUrl: string; serviceRoleKey: string } => {
  const values = Object.fromEntries(
    output.split(/\r?\n/).flatMap((line) => {
      const match = /^(API_URL|SERVICE_ROLE_KEY)=(.*)$/.exec(line);
      if (!match) {
        return [];
      }
      const value = match[2]?.replace(/^['"]|['"]$/g, '') ?? '';
      return [[match[1] as string, value]];
    }),
  );
  const apiUrl = values.API_URL;
  const serviceRoleKey = values.SERVICE_ROLE_KEY;
  if (!apiUrl || !serviceRoleKey) {
    throw new Error('Supabase status did not report API_URL and SERVICE_ROLE_KEY.');
  }
  const url = new URL(apiUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Synthetic Supabase seed is restricted to a local loopback API.');
  }
  return { apiUrl: url.origin, serviceRoleKey };
};

const boundedResponse = async (response: Response): Promise<void> => {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 256_000) {
    throw new Error('Local Supabase seed response exceeded its byte budget.');
  }
  if (!response.ok) {
    throw new Error(`Local Supabase seed request failed (${response.status}).`);
  }
};

/** Uses local Auth admin plus PostgREST so the auth lifecycle and UUID schema stay real. */
export const seedSupabaseLocal = async (
  options: {
    root?: string;
    binary?: string;
    fetcher?: SeedFetch;
    run?: (
      command: string,
      args: readonly string[],
      cwd: string,
    ) => { code: number; stdout: string; stderr: string };
  } = {},
): Promise<{ userId: string; noteCount: number }> => {
  const root = options.root ?? REPO_ROOT;
  const binary = options.binary ?? supabaseBin(root);
  if (!binary) {
    throw new Error('Pinned Supabase CLI is unavailable; run bun install.');
  }
  const run =
    options.run ??
    ((command, args, cwd) =>
      runBoundedSync({ command, args, cwd, timeoutMs: 30_000, maxBytes: 256_000 }));
  const status = run(binary, ['status', '--output', 'env', '--workdir', root], root);
  if (status.code !== 0) {
    throw new Error(
      `Local Supabase status failed with exit ${status.code}. Start the checkout-owned stack first.`,
    );
  }
  const { apiUrl, serviceRoleKey } = parseStatus(status.stdout);
  const fetcher = options.fetcher ?? fetch;
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
  const userUrl = `${apiUrl}/auth/v1/admin/users/${USER_ID}`;
  const user = await fetcher(userUrl, { headers, signal: AbortSignal.timeout(8_000) });
  if (user.status === 404) {
    const created = await fetcher(`${apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: USER_ID,
        email: 'seed@example.invalid',
        password: 'local-synthetic-seed-only',
        email_confirm: true,
        user_metadata: { name: 'Seed User' },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    await boundedResponse(created);
  } else {
    await boundedResponse(user);
  }
  const notes = await fetcher(`${apiUrl}/rest/v1/notes?on_conflict=id`, {
    method: 'POST',
    headers: { ...headers, prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(NOTES),
    signal: AbortSignal.timeout(8_000),
  });
  await boundedResponse(notes);
  return { userId: USER_ID, noteCount: NOTES.length };
};
