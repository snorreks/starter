import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import {
  createSupabaseJobRepository,
  createSupabaseNotesRepository,
  type Database,
} from '../src/supabase/index.ts';

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

    const listA = await repoA.list(userA.id, null);
    expect(listA.notes.some((note) => note.id === noteB.id)).toBe(false);
    expect(listA.hasMore).toBe(false);
    const update = await repoA.update(userA.id, noteB.id, { title: 'spoofed' });
    expect(update).toBeNull();
    expect(await repoA.remove(userA.id, noteB.id)).toBe(false);
    expect(
      (await repoB.list(userB.id, null)).notes.find((note) => note.id === noteB.id)?.title,
    ).toBe('Private to B');

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
      p_client_id: 'x'.repeat(118),
      p_request_fingerprint: fingerprint,
      p_user_message_id: userMessageId,
      p_content: 'hello',
    };
    for (const clientId of ['', 'x'.repeat(119), 'assistant:reserved']) {
      const admission = await userA.client.rpc('admit_chat_generation', {
        ...args,
        p_client_id: clientId,
      });
      expect(admission.error?.code).toBe('22023');
      const completion = await admin.rpc('complete_chat_generation', {
        p_conversation_id: conversation.id,
        p_client_id: clientId,
        p_attempt: 1,
        p_content: 'answer',
      });
      expect(completion.error?.code).toBe('22023');
    }
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
    await sql`update private.chat_generations set updated_at=now()-interval '61 seconds'
      where owner_id=${userA.id} and conversation_id=${conversation.id} and client_id=${args.p_client_id}`;
    const reclaimed = await userA.client.rpc('admit_chat_generation', args);
    expect(reclaimed.data?.[0]?.outcome).toBe('admitted');
    expect(reclaimed.data?.[0]?.attempt).toBe(admittedRow.attempt + 2);
    const secondOwnerSlot = await userA.client.rpc('admit_chat_generation', {
      ...args,
      p_client_id: 'second-active-generation',
      p_request_fingerprint: await digest('second active generation'),
      p_user_message_id: crypto.randomUUID(),
      p_content: 'second',
    });
    expect(secondOwnerSlot.data?.[0]?.outcome).toBe('admitted');
    const thirdOwnerSlot = await userA.client.rpc('admit_chat_generation', {
      ...args,
      p_client_id: 'third-active-generation',
      p_request_fingerprint: await digest('third active generation'),
      p_user_message_id: crypto.randomUUID(),
      p_content: 'third',
    });
    expect(thirdOwnerSlot.error?.message).toContain('owner chat concurrency limit reached');
    const independentConversation = await userB.client
      .from('conversations')
      .insert({ owner_id: userB.id, title: 'Independent owner' })
      .select('id')
      .single();
    if (independentConversation.error || !independentConversation.data) {
      throw new Error(
        `Independent owner fixture failed: ${independentConversation.error?.message}`,
      );
    }
    const independentAdmission = await userB.client.rpc('admit_chat_generation', {
      p_conversation_id: independentConversation.data.id,
      p_client_id: 'independent-owner-generation',
      p_request_fingerprint: await digest('independent owner generation'),
      p_user_message_id: crypto.randomUUID(),
      p_content: 'independent',
    });
    expect(independentAdmission.data?.[0]?.outcome).toBe('admitted');
    await admin.rpc('fail_chat_generation', {
      p_conversation_id: independentConversation.data.id,
      p_client_id: 'independent-owner-generation',
      p_attempt: independentAdmission.data?.[0]?.attempt ?? 0,
      p_state: 'cancelled',
    });
    await admin.rpc('fail_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: 'second-active-generation',
      p_attempt: secondOwnerSlot.data?.[0]?.attempt ?? 0,
      p_state: 'cancelled',
    });
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
      p_attempt: reclaimed.data?.[0]?.attempt ?? 0,
      p_content: 'trusted server completion',
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toBe(admittedRow.assistant_message_id);
    const assistant = await admin
      .from('messages')
      .select('client_id')
      .eq('id', admittedRow.assistant_message_id)
      .single();
    expect(assistant.error).toBeNull();
    expect(assistant.data?.client_id).toBe(`assistant:${args.p_client_id}`);
    expect(assistant.data?.client_id).toHaveLength(128);

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
    expect(Number(counter[0]?.admitted)).toBeLessThanOrEqual(5);
    const accepted = distinct.filter((result) => result.error === null).length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(3);
    expect(distinct.filter((result) => result.error !== null).length).toBe(7 - accepted);
  });

  test('failed retries consume the same five-per-hour admission quota', async () => {
    const { data: conversation, error } = await userB.client
      .from('conversations')
      .insert({ owner_id: userB.id, title: 'Retry quota fixture' })
      .select('id')
      .single();
    if (error || !conversation) {
      throw new Error(`Retry quota conversation fixture failed: ${error?.message}`);
    }
    const args = {
      p_conversation_id: conversation.id,
      p_client_id: 'quota-retry-key',
      p_request_fingerprint: await digest('same retry content'),
      p_user_message_id: crypto.randomUUID(),
      p_content: 'retry',
    };
    const first = await userB.client.rpc('admit_chat_generation', args);
    expect(first.data?.[0]?.outcome).toBe('admitted');
    let attempt = first.data?.[0]?.attempt ?? 0;
    for (let retry = 0; retry < 3; retry += 1) {
      const failed = await admin.rpc('fail_chat_generation', {
        p_conversation_id: conversation.id,
        p_client_id: args.p_client_id,
        p_attempt: attempt,
        p_state: 'failed',
      });
      expect(failed.data).toBe(true);
      const admitted = await userB.client.rpc('admit_chat_generation', args);
      expect(admitted.data?.[0]?.outcome).toBe('admitted');
      attempt = admitted.data?.[0]?.attempt ?? 0;
    }
    await admin.rpc('fail_chat_generation', {
      p_conversation_id: conversation.id,
      p_client_id: args.p_client_id,
      p_attempt: attempt,
      p_state: 'failed',
    });
    const overQuota = await userB.client.rpc('admit_chat_generation', args);
    expect(overQuota.error?.message).toContain('chat admission limit reached');
    const counter =
      await sql`select admitted from private.admission_counters where owner_id=${userB.id}`;
    expect(Number(counter[0]?.admitted)).toBe(5);
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

    const ownerStatus = await userB.client.rpc('get_encode_job', { p_job_id: jobId });
    const otherStatus = await userA.client.rpc('get_encode_job', { p_job_id: jobId });
    const ownerList = await userB.client.rpc('list_encode_jobs');
    const otherList = await userA.client.rpc('list_encode_jobs');
    expect(ownerStatus.data).toMatchObject({
      id: jobId,
      status: 'pending',
      outputAvailable: false,
    });
    expect(otherStatus.data).toBeNull();
    expect(ownerList.data).toContainEqual(expect.objectContaining({ id: jobId }));
    expect(otherList.data).not.toContainEqual(expect.objectContaining({ id: jobId }));
    expect(
      await userB.client.rpc('record_job_dispatch', {
        p_job_id: jobId,
        p_dispatch_state: 'dispatch_failed',
        p_error_code: 'dispatch_disabled_pending_prompt_06',
      }),
    ).toMatchObject({ error: { code: '42501' } });
    expect(
      await admin.rpc('record_job_dispatch', {
        p_job_id: jobId,
        p_dispatch_state: 'dispatch_failed',
        p_error_code: 'dispatch_disabled_pending_prompt_06',
      }),
    ).toMatchObject({ data: true, error: null });

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

test('retention attempts are durable and fresh rows outrank unchanged refusals', async () => {
  const cutoff = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const insertExpired = async (id: string) => {
    await sql`insert into private.jobs
      (id, owner_id, status, fixture, preset, idempotency_key, request_fingerprint,
       workflow_id, output_key, output_expires_at)
      values (${id}, ${userB.id}, 'succeeded', 'sample-v1', 'demo-180p-v1', ${id},
        ${'a'.repeat(64)}, ${`encode-${id}`}, ${`media/v1/jobs/${id}/attempts/a.mp4`},
        now()-interval '20 days')`;
  };
  const queue = async () => {
    const result = await admin.rpc('queue_expired_job_artifacts', { p_cutoff: cutoff, p_limit: 1 });
    expect(result.error).toBeNull();
    return result.data;
  };
  await insertExpired('job_retention_refused');
  expect((await queue())?.map((row) => row.job_id)).toEqual(['job_retention_refused']);
  // Validation/R2 refusals leave this row unchanged; its issued attempt is durable.
  expect(
    await sql`select runs from private.job_artifact_retirements where job_id='job_retention_refused'`,
  ).toMatchObject([{ runs: 1 }]);
  await insertExpired('job_retention_fresh');
  expect((await queue())?.map((row) => row.job_id)).toEqual(['job_retention_fresh']);
  expect((await queue())?.map((row) => row.job_id)).toEqual(['job_retention_refused']);
  expect(
    await sql`select runs from private.job_artifact_retirements where job_id='job_retention_refused'`,
  ).toMatchObject([{ runs: 2 }]);
  const repository = createSupabaseJobRepository(userB.client, admin);
  expect((await repository.getForOwner('job_retention_fresh'))?.dispatchState).toBe('pending');
  await sql`update private.jobs set dispatch_state='dispatch_failed' where id='job_retention_fresh'`;
  expect(
    (await repository.listForOwner()).find((job) => job.id === 'job_retention_fresh')
      ?.dispatchState,
  ).toBe('dispatch_failed');
  const retired = await admin.rpc('retire_job_artifact', {
    p_job_id: 'job_retention_fresh',
    p_output_key: 'media/v1/jobs/job_retention_fresh/attempts/a.mp4',
  });
  expect(retired.error).toBeNull();
  expect(retired.data).toBe(true);
});
