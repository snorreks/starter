import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { createSupabaseNotesRepository, type Database } from '../src/supabase/index.ts';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!url || !anonKey || !serviceKey || !dbUrl) {
  throw new Error(
    'Database integration lane requires the run-owned SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL.',
  );
}

const admin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = postgres(dbUrl, { max: 2, connect_timeout: 10 });
let userA: { id: string; token: string; client: ReturnType<typeof createClient<Database>> };
let userB: { id: string; token: string; client: ReturnType<typeof createClient<Database>> };
const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString(
    'hex',
  );
const signup = async (email: string, password: string) => {
  const response = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const payload = (await response.json()) as { access_token?: string; user?: { id: string } };
  if (!response.ok || payload.access_token === undefined || payload.user?.id === undefined) {
    throw new Error(`Local Auth signup failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return {
    id: payload.user.id,
    token: payload.access_token,
    client: createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${payload.access_token}` } },
    }),
  };
};

beforeAll(async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL('../../../../supabase/tests/fixtures/synthetic_users.json', import.meta.url),
      'utf8',
    ),
  ) as {
    users: [{ email: string; password: string }, { email: string; password: string }];
  };
  userA = await signup(fixtures.users[0].email, fixtures.users[0].password);
  userB = await signup(fixtures.users[1].email, fixtures.users[1].password);
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('the real local Supabase Data API enforces owner boundaries', () => {
  test('supported Auth signups create matching auth.users and application profiles', async () => {
    const authRows =
      await sql`select id::text as id from auth.users where id in (${userA.id}::uuid, ${userB.id}::uuid)`;
    const profileRows =
      await sql`select id::text as id from public.profiles where id in (${userA.id}::uuid, ${userB.id}::uuid)`;
    expect(authRows.map((row) => row.id).sort()).toEqual([userA.id, userB.id].sort());
    expect(profileRows.map((row) => row.id).sort()).toEqual([userA.id, userB.id].sort());
  });

  test('other users cannot read, update or delete a note, and owner spoofing/anonymous/internal access fail', async () => {
    const repoA = createSupabaseNotesRepository(userA.client);
    const repoB = createSupabaseNotesRepository(userB.client);
    const noteB = await repoB.create(userB.id, { title: 'Private to B', body: 'fixture' });
    expect(noteB.ownerId).toBe(userB.id);
    expect(noteB.id).toMatch(/^note_[0-9a-f-]{36}$/i);
    expect(noteB.createdAt).toBeGreaterThan(1_700_000_000_000);

    const listA = await repoA.list(userA.id, 0);
    expect(listA.notes.some((note) => note.id === noteB.id)).toBe(false);
    expect(listA.hasMore).toBe(false);
    const update = await repoA.update(userA.id, noteB.id, { title: 'spoofed' });
    expect(update).toBeNull();
    expect(await repoA.remove(userA.id, noteB.id)).toBe(false);
    expect((await repoB.list(userB.id, 0)).notes.find((note) => note.id === noteB.id)?.title).toBe(
      'Private to B',
    );

    const spoof = await fetch(`${url}/rest/v1/notes`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ owner_id: userB.id, title: 'owner spoof', body: '' }),
    });
    expect(spoof.status).toBeGreaterThanOrEqual(400);
    const anonymous = await fetch(`${url}/rest/v1/notes`, { headers: { apikey: anonKey } });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    const internal = await fetch(`${url}/rest/v1/jobs`, {
      headers: { apikey: anonKey, authorization: `Bearer ${userA.token}` },
    });
    expect(internal.status).toBeGreaterThanOrEqual(400);
  });
});

describe('transactional admission and attempt fencing in Postgres', () => {
  test('a chat key admits once, changed content conflicts, and the quota counter never exceeds five', async () => {
    const { data: conversation, error } = await userA.client
      .from('conversations')
      .insert({ owner_id: userA.id, title: 'Concurrency fixture' })
      .select('id')
      .single();
    if (error || !conversation) {
      throw new Error(`Conversation fixture failed: ${error?.message}`);
    }
    const bypass = await fetch(`${url}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: conversation.id,
        author_id: userA.id,
        role: 'user',
        content: 'bypass',
        client_id: 'unadmitted',
      }),
    });
    expect(bypass.status).toBeGreaterThanOrEqual(400);
    const fingerprint = await digest('same canonical payload');
    const userMessageId = crypto.randomUUID();
    const args = {
      p_conversation_id: conversation.id,
      p_client_id: 'turn-same-key',
      p_request_fingerprint: fingerprint,
      p_user_message_id: userMessageId,
      p_content: 'hello',
    };
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => userA.client.rpc('admit_chat_generation', args)),
    );
    expect(contenders.every((result) => result.error === null)).toBe(true);
    const outcomes = contenders.flatMap((result) => result.data ?? []).map((row) => row.outcome);
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(1);
    expect(
      new Set(
        contenders.flatMap((result) => result.data ?? []).map((row) => row.assistant_message_id),
      ).size,
    ).toBe(1);
    const changed = await userA.client.rpc('admit_chat_generation', {
      ...args,
      p_request_fingerprint: await digest('changed payload'),
    });
    expect(changed.error).not.toBeNull();
    const forbiddenCompletion = await userA.client.rpc('complete_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: args.p_client_id,
      p_attempt: 1,
      p_content: 'fake assistant output',
    });
    expect(forbiddenCompletion.error).not.toBeNull();
    const admittedRow = contenders.flatMap((result) => result.data ?? [])[0];
    if (admittedRow === undefined) {
      throw new Error('chat admission did not return the stable assistant identity');
    }
    const failed = await admin.rpc('fail_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: args.p_client_id,
      p_attempt: admittedRow.attempt,
      p_state: 'failed',
    });
    expect(failed.data).toBe(true);
    const retried = await userA.client.rpc('admit_chat_generation', args);
    expect(retried.error?.message ?? retried.data?.[0]?.outcome).toBe('admitted');
    expect(retried.data?.[0]?.assistant_message_id).toBe(admittedRow.assistant_message_id);
    expect(retried.data?.[0]?.attempt).toBe(admittedRow.attempt + 1);
    const staleCompletion = await admin.rpc('complete_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: args.p_client_id,
      p_attempt: admittedRow.attempt,
      p_content: 'stale output',
    });
    expect(staleCompletion.error).not.toBeNull();
    const completed = await admin.rpc('complete_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: args.p_client_id,
      p_attempt: admittedRow.attempt + 1,
      p_content: 'trusted server completion',
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toBe(admittedRow.assistant_message_id);

    const distinct = await Promise.all(
      Array.from({ length: 7 }, async (_, i) =>
        userA.client.rpc('admit_chat_generation', {
          p_conversation_id: conversation.id,
          p_client_id: `quota-${i}`,
          p_request_fingerprint: await digest(`quota-${i}`),
          p_user_message_id: crypto.randomUUID(),
          p_content: 'q',
        }),
      ),
    );
    const counter =
      await sql`select admitted from private.admission_counters where owner_id=${userA.id}`;
    expect(Number(counter[0]?.admitted)).toBe(5);
    expect(distinct.filter((result) => result.error === null).length).toBe(4);
    expect(distinct.filter((result) => result.error !== null).length).toBe(3);
  });

  test('only one service lease wins and stale completion cannot overwrite the reclaimed attempt', async () => {
    const jobId = `job_${crypto.randomUUID()}`;
    const admitted = await userB.client.rpc('admit_encode_job', {
      p_job_id: jobId,
      p_fixture: 'sample-v1',
      p_preset: 'demo-180p-v1',
      p_idempotency_key: `key-${crypto.randomUUID()}`,
      p_fingerprint: await digest('fixture:sample-v1:preset:demo-180p-v1'),
      p_workflow_id: `workflow-${crypto.randomUUID()}`,
    });
    expect(admitted.error).toBeNull();
    expect(admitted.data?.[0]?.outcome).toBe('created');

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        admin.rpc('claim_encode_job', { p_job_id: jobId, p_attempt_id: `attempt-${i}` }),
      ),
    );
    expect(claims.filter((result) => result.data === true)).toHaveLength(1);
    const first = claims.find((result) => result.data === true);
    const firstAttempt = first === undefined ? '' : claims.indexOf(first);
    await sql`update private.jobs set lease_expires_at=now()-interval '1 second' where id=${jobId}`;
    const reclaimed = await admin.rpc('claim_encode_job', {
      p_job_id: jobId,
      p_attempt_id: 'attempt-reclaimed',
    });
    expect(reclaimed.data).toBe(true);
    const stale = await admin.rpc('finish_encode_job', {
      p_job_id: jobId,
      p_attempt_id: `attempt-${firstAttempt}`,
      p_output_key: 'private/key',
      p_output_bytes: 1,
      p_sha256: 'a'.repeat(64),
      p_format: 'mp4',
      p_codec: 'h264',
      p_width: 320,
      p_height: 180,
      p_duration_ms: 1000,
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toBe(false);
    const current = await admin.rpc('finish_encode_job', {
      p_job_id: jobId,
      p_attempt_id: 'attempt-reclaimed',
      p_output_key: 'private/key',
      p_output_bytes: 1,
      p_sha256: 'a'.repeat(64),
      p_format: 'mp4',
      p_codec: 'h264',
      p_width: 320,
      p_height: 180,
      p_duration_ms: 1000,
    });
    expect(current.data).toBe(true);
    await sql`update private.jobs set output_expires_at=now()-interval '1 second' where id=${jobId}`;
    const queued = await admin.rpc('queue_expired_job_artifacts', {
      p_cutoff: new Date().toISOString(),
      p_limit: 100,
    });
    expect(queued.error).toBeNull();
    expect(
      queued.data?.some((row) => row.job_id === jobId && row.output_key === 'private/key'),
    ).toBe(true);
    const staleRetire = await admin.rpc('retire_job_artifact', {
      p_job_id: jobId,
      p_output_key: 'private/old-key',
    });
    expect(staleRetire.data).toBe(false);
    const retirementRows =
      (await sql`select count(*)::int as count from private.job_artifact_retirements where job_id=${jobId}`) as unknown as {
        count: number;
      }[];
    expect(retirementRows).toEqual([{ count: 1 }]);
    const retired = await admin.rpc('retire_job_artifact', {
      p_job_id: jobId,
      p_output_key: 'private/key',
    });
    expect(retired.data).toBe(true);
    const retainedJob =
      (await sql`select status,output_key from private.jobs where id=${jobId}`) as unknown as {
        status: string;
        output_key: string | null;
      }[];
    expect(retainedJob).toEqual([{ status: 'succeeded', output_key: null }]);
  });
});
