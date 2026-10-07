import { expect, mock, test } from 'bun:test';
import { decodeChatStream, type Message } from '@starter/schemas/chat';
import { POST as postChat } from '../../routes/api/chat/conversations/[id]/messages/+server.ts';
import { GET as getJobs, POST as postJob } from '../../routes/api/jobs/+server.ts';
import { GET as getJob } from '../../routes/api/jobs/[id]/+server.ts';
import { createRequestNotesService } from './notes_service.ts';

const user = { id: 'owner', emailVerified: true };
const conversationId = 'conv_12345678-1234-4123-8123-123456789012';
const storedUser: Message = {
  id: 'msg_12345678-1234-4123-8123-123456789012',
  conversationId,
  authorId: user.id,
  role: 'user',
  content: 'hello',
  status: 'complete',
  createdAt: 1,
};
const storedAssistant: Message = {
  ...storedUser,
  id: 'msg_87654321-1234-4123-8123-123456789012',
  role: 'assistant',
  content: 'saved reply',
};
const chatFixture = (
  outcome: 'admitted' | 'completed' | 'in_flight' | 'running' | 'conflict',
  missing = false,
) => {
  const chat = {
    findConversation: mock(async () => (missing ? null : { id: conversationId })),
    listConversations: mock(async () => []),
    listMessages: mock(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
      serverTime: 1,
    })),
    findMessageByClientId: mock(async (_owner: string, _conversation: string, id: string) =>
      id.startsWith('assistant:') ? storedAssistant : storedUser,
    ),
    admitGeneration: mock(async () => ({
      outcome,
      assistantMessageId: storedAssistant.id,
      attempt: 3,
    })),
    completeGeneration: mock(async () => storedAssistant.id),
    failGeneration: mock(async () => {}),
  };
  const generate = mock(async function* () {
    yield { text: 'new reply' };
  });
  const event = {
    locals: {
      user,
      context: { backendProfile: 'supabase', user, services: { identity: { user }, chat } },
      container: { chatModel: { generate } },
    },
    params: { id: conversationId },
    request: new Request('http://localhost/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello', clientId: 'turn' }),
    }),
  } as unknown as Parameters<typeof postChat>[0];
  return { chat, generate, event };
};

test('a conversation outside page zero streams with the admitted assistant ID', async () => {
  const { chat, generate, event } = chatFixture('admitted');
  const response = await postChat(event);
  expect(response.status).toBe(200);
  const frames = decodeChatStream(await response.text());
  expect(chat.findConversation).toHaveBeenCalledWith('owner', conversationId);
  expect(chat.listConversations).not.toHaveBeenCalled();
  expect(frames[0]).toMatchObject({ type: 'user-message', message: { id: storedUser.id } });
  expect(frames[1]).toEqual({ type: 'start', messageId: storedAssistant.id });
  expect(frames.at(-1)).toMatchObject({
    type: 'complete',
    message: { id: storedAssistant.id, content: 'new reply' },
  });
  expect(chat.completeGeneration).toHaveBeenCalledWith({
    conversationId,
    clientId: 'turn',
    attempt: 3,
    content: 'new reply',
  });
  expect(generate).toHaveBeenCalledTimes(1);
});

test('a completed retry replays stored messages without regenerating or completing again', async () => {
  const { chat, generate, event } = chatFixture('completed');
  const response = await postChat(event);
  expect(decodeChatStream(await response.text())).toEqual([
    { type: 'user-message', clientId: 'turn', message: storedUser },
    { type: 'start', messageId: storedAssistant.id },
    { type: 'complete', message: storedAssistant },
  ]);
  expect(generate).not.toHaveBeenCalled();
  expect(chat.completeGeneration).not.toHaveBeenCalled();
});

test('provider completion followed by a persistence failure records a failed attempt and emits a terminal error', async () => {
  const { chat, event } = chatFixture('admitted');
  chat.completeGeneration = mock(async () => {
    throw new Error('database unavailable');
  });
  const response = await postChat(event);
  const frames = decodeChatStream(await response.text());
  expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'persistence_failed' });
  expect(chat.failGeneration).toHaveBeenCalledWith({
    conversationId,
    clientId: 'turn',
    attempt: 3,
    state: 'failed',
  });
});

test('a running turn returns a recoverable 409 while a missing conversation remains 404', async () => {
  for (const missing of [false, true]) {
    const { chat, generate, event } = chatFixture(missing ? 'running' : 'running', missing);
    const response = await postChat(event);
    expect(response.status).toBe(missing ? 404 : 409);
    expect(await response.json()).toMatchObject(
      missing ? { error: 'not_found' } : { code: 'running', recoverable: true },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(chat.findMessageByClientId).not.toHaveBeenCalled();
    if (missing) {
      expect(chat.admitGeneration).not.toHaveBeenCalled();
    }
  }
});

test('a reused idempotency key with changed content returns conflict without provider work', async () => {
  const { generate, event } = chatFixture('conflict');
  const response = await postChat(event);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'conflict' });
  expect(generate).not.toHaveBeenCalled();
});

test('notes follow pages until the last page or the 200-note limit', async () => {
  for (const total of [73, 230]) {
    const notes = Array.from({ length: total }, (_, id) => ({
      id: String(id),
      ownerId: user.id,
      title: 'note',
      body: '',
      createdAt: 1,
      updatedAt: 1,
    }));
    const calls: (string | null)[] = [];
    const list = mock(async (_owner: string, cursor: string | null) => {
      calls.push(cursor);
      const page = cursor === null ? 0 : Number(atob(cursor));
      const hasMore = (page + 1) * 50 < total;
      return {
        notes: notes.slice(page * 50, (page + 1) * 50),
        hasMore,
        serverTime: 1,
        nextCursor: hasMore ? btoa(String(page + 1)) : null,
      };
    });
    const service = createRequestNotesService({
      context: {
        backendProfile: 'supabase',
        user,
        services: { identity: { user }, notes: { list } },
      },
    } as unknown as Parameters<typeof createRequestNotesService>[0]);
    expect(await service.list(user.id)).toEqual(notes.slice(0, 200));
    expect(calls).toEqual(
      Array.from({ length: Math.ceil(Math.min(total, 200) / 50) }, (_, page) =>
        page === 0 ? null : btoa(String(page)),
      ),
    );
    await expect(service.list('other')).rejects.toThrow(/owner/);
  }
});

test('Supabase job admission starts one Cloudflare Workflow and a failed start is visible', async () => {
  for (const [outcome, dispatchState] of [
    ['created', 'pending'],
    ['replayed', 'pending'],
    ['replayed', 'dispatch_failed'],
    ['replayed', 'dispatched'],
  ] as const) {
    const shouldStart = outcome === 'created' || dispatchState !== 'dispatched';
    const jobs = {
      dispatch: 'cloud_run',
      admit: mock(
        async (input: { id: string; fixture: string; preset: string; workflowId: string }) => ({
          outcome,
          jobId: input.id,
        }),
      ),
      disableDispatch: mock(async () => false),
      startEncode: mock(
        async (_input: {
          jobId: string;
          fixture: 'sample-v1';
          preset: 'demo-180p-v1';
          attemptId: string;
        }) => false,
      ),
      getForOwner: mock(async () => ({ id: 'job', dispatchState })),
    };
    const response = await postJob({
      locals: {
        context: { backendProfile: 'supabase', user },
        applicationServices: { identity: { user }, jobs },
      },
      request: new Request('http://localhost/api/jobs', {
        method: 'POST',
        headers: { 'idempotency-key': 'turn' },
        body: JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' }),
      }),
    } as unknown as Parameters<typeof postJob>[0]);
    expect(response.status).toBe(shouldStart ? 503 : 202);
    expect(jobs.startEncode).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    expect(jobs.disableDispatch).not.toHaveBeenCalled();
    if (shouldStart) {
      const admitted = jobs.admit.mock.calls[0]?.[0];
      expect(admitted).toMatchObject({ fixture: 'sample-v1', preset: 'demo-180p-v1' });
      expect(admitted?.workflowId).toBe(`encode-${admitted?.id}`);
      expect(jobs.startEncode.mock.calls[0]?.[0]).toMatchObject({
        jobId: admitted?.id,
        fixture: 'sample-v1',
        preset: 'demo-180p-v1',
      });
      expect(await response.json()).toMatchObject({ error: 'job_dispatch_failed' });
      expect(jobs.getForOwner).toHaveBeenCalledTimes(outcome === 'created' ? 0 : 1);
    } else {
      expect((await response.json()) as { id: string }).toEqual({ id: 'job' });
    }
  }
});

test('Supabase job reads keep dispatch state out of the public DTO', async () => {
  const job = { id: 'job_a', dispatchState: 'dispatch_failed' };
  const locals = {
    user,
    context: { backendProfile: 'supabase', user },
    applicationServices: {
      identity: { user },
      jobs: {
        listForOwner: async () => [job],
        getForOwner: async () => job,
      },
    },
  };
  const list = await getJobs({ locals } as unknown as Parameters<typeof getJobs>[0]);
  const listBody = await list.json();
  expect(listBody).toMatchObject({ jobs: [{ id: 'job_a' }] });
  expect(JSON.stringify(listBody)).not.toContain('dispatchState');
  const detail = await getJob({ locals, params: { id: job.id } } as unknown as Parameters<
    typeof getJob
  >[0]);
  const detailBody = await detail.json();
  expect(detailBody).toMatchObject({ id: 'job_a' });
  expect(JSON.stringify(detailBody)).not.toContain('dispatchState');
});
