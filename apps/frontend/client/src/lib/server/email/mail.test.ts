// apps/frontend/client/src/lib/server/email/mail.test.ts
//
// The email boundary, with the provider replaced by a scripted `fetch`.
//
// Every failure mode here is one a real deployment hits: a missing key, a domain
// that is not verified, a provider that stalls, a provider that is briefly down.
// Each is injected rather than simulated by inspection, because the interesting
// bug is always "the caller's promise resolved anyway".

import { describe, expect, mock, test } from 'bun:test';
import { CAPTURE_INBOX_LIMIT, createCaptureMailService } from './capture_transport.ts';
import {
  CAPTURE_FROM,
  MailCaptureRefused,
  MailDeliveryError,
  type OutboundEmail,
  resolveMail,
} from './mail.ts';
import { createResendMailService, type ResendFetch } from './resend_transport.ts';

const MESSAGE: OutboundEmail = {
  to: 'someone@example.com',
  subject: 'Verify your email',
  text: 'https://starter.example/verify-email?token=super-secret-token',
};

describe('mail configuration refuses before a sign-up can mislead anyone', () => {
  test('a deployed environment with no API key is a configuration error', () => {
    const resolved = resolveMail({ RESEND_API_KEY: '   ' }, false);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.problem).toContain('RESEND_API_KEY');
    // The refusal has to explain what breaks without it, or an operator reads a
    // message about a missing variable and assumes it is optional.
    expect(resolved.problem).toContain('report success and deliver nothing');
    expect(resolved.remedy).toContain('wrangler secret put');
  });

  test('a deployed environment cannot select the capture inbox', () => {
    const resolved = resolveMail({}, false);

    // This is the assertion that matters most in this file. The tempting
    // configuration — a deployed Worker with no mail key quietly keeping a local
    // inbox — would report every sign-up as successful and deliver nothing.
    expect(resolved.ok).toBe(false);
  });

  test('an API key with no sender address is still refused', () => {
    const resolved = resolveMail({ RESEND_API_KEY: 're_live_abc' }, false);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.problem).toContain('MAIL_FROM');
  });

  test('a complete deployed configuration resolves to Resend', () => {
    const resolved = resolveMail(
      { RESEND_API_KEY: 're_live_abc', MAIL_FROM: 'Starter <no-reply@example.com>' },
      false,
    );

    expect(resolved).toEqual({
      ok: true,
      mode: 'resend',
      apiKey: 're_live_abc',
      from: 'Starter <no-reply@example.com>',
      inbox: '',
    });
  });

  test('local capture is namespaced by the run id', () => {
    const first = resolveMail({ TEST_RUN_ID: 'run-a' }, true);
    const second = resolveMail({ TEST_RUN_ID: 'run-b' }, true);

    expect(first.ok && first.inbox).toBe('run-a');
    expect(second.ok && second.inbox).toBe('run-b');
    expect(first.ok && first.from).toBe(CAPTURE_FROM);
  });

  test('local ignores a present API key rather than sending real mail', () => {
    const resolved = resolveMail({ RESEND_API_KEY: 're_live_abc' }, true);

    // A developer with a stray key in `.env` must not be able to mail strangers
    // by running `bun run dev`.
    expect(resolved.ok && resolved.mode).toBe('capture');
  });
});

describe('the capture inbox', () => {
  const local = () =>
    createCaptureMailService({ isLocal: true, inboxId: 'run-a', from: CAPTURE_FROM });

  test('refuses to be constructed outside a local environment', () => {
    expect(() =>
      createCaptureMailService({ isLocal: false, inboxId: 'run-a', from: CAPTURE_FROM }),
    ).toThrow(MailCaptureRefused);
  });

  test('keeps messages retrievable for the run that sent them', async () => {
    const mail = local();
    const delivery = await mail.send(MESSAGE);

    expect(delivery.mode).toBe('capture');
    expect(mail.inbox()).toHaveLength(1);
    expect(mail.latestFor(MESSAGE.to)?.text).toContain('super-secret-token');
    expect(mail.latestFor('nobody@example.com')).toBeUndefined();
  });

  test('is bounded, so a runaway loop cannot exhaust the isolate', async () => {
    const mail = local();
    for (let index = 0; index < CAPTURE_INBOX_LIMIT + 25; index += 1) {
      await mail.send({ ...MESSAGE, subject: `message ${index}` });
    }

    expect(mail.inbox()).toHaveLength(CAPTURE_INBOX_LIMIT);
    // Newest kept: an older message is never the one a test is looking for.
    expect(mail.inbox().at(-1)?.subject).toBe(`message ${CAPTURE_INBOX_LIMIT + 24}`);
  });

  test('two runs do not see each other’s mail', async () => {
    const runA = local();
    const runB = createCaptureMailService({
      isLocal: true,
      inboxId: 'run-b',
      from: CAPTURE_FROM,
    });

    await runA.send(MESSAGE);

    // The isolation claim is that a message from an earlier run cannot make a
    // later run's verification succeed. It holds because each run owns its
    // service instance, and the inbox id is what selects one in the container.
    expect(runA.inbox()).toHaveLength(1);
    expect(runB.inbox()).toHaveLength(0);
  });

  test('never reports a message id that leaks the message', async () => {
    const mail = local();
    const delivery = await mail.send(MESSAGE);

    // The returned id is the one value a caller might log. It must not embed the
    // recipient or the token.
    expect(delivery.id).not.toContain('example.com');
    expect(delivery.id).not.toContain('super-secret-token');
  });
});

describe('the Resend transport', () => {
  const service = (fetchImpl: ResendFetch) =>
    createResendMailService({
      apiKey: 're_live_abc',
      from: 'no-reply@example.com',
      fetch: fetchImpl,
    });

  const ok = (body: unknown = { id: 'msg_1' }) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  test('sends the address as an array and reports the provider id', async () => {
    const calls: Array<{ url: string; init: Parameters<ResendFetch>[1] }> = [];
    const mail = service((url, init) => {
      calls.push({ url, init });
      return ok();
    });

    const delivery = await mail.send(MESSAGE);

    expect(delivery).toEqual({ id: 'msg_1', mode: 'resend' });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]?.init.body ?? '{}');
    expect(sent.to).toEqual([MESSAGE.to]);
    expect(sent.from).toBe('no-reply@example.com');
    expect(calls[0]?.init.headers.authorization).toBe('Bearer re_live_abc');
  });

  test('a rejected sender is not reported as retryable', async () => {
    const mail = service(() =>
      Promise.resolve(new Response('{"message":"domain not verified"}', { status: 422 })),
    );

    const error = await mail.send(MESSAGE).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).reason).toBe('rejected');
    // Retrying a domain that is not verified fails identically forever, so
    // advertising it as retryable would send an operator in circles.
    expect((error as MailDeliveryError).retryable).toBe(false);
  });

  test('a provider outage is reported as retryable', async () => {
    const mail = service(() => Promise.resolve(new Response('upstream', { status: 503 })));

    const error = (await mail
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown)) as MailDeliveryError;

    expect(error.reason).toBe('transport');
    expect(error.retryable).toBe(true);
  });

  test('a rate limit is the provider’s problem, not a bad request', async () => {
    const mail = service(() => Promise.resolve(new Response('slow down', { status: 429 })));

    const error = (await mail
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown)) as MailDeliveryError;

    // 429 arrives in the 4xx range but is explicitly about volume, so it must not
    // be classified with the errors that can never succeed.
    expect(error.reason).toBe('transport');
    expect(error.retryable).toBe(true);
  });

  test('a stalled provider fails on the timeout, not on the platform', async () => {
    const listen = mock(
      (_input: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason as Error);
          });
        }),
    );
    const mail = createResendMailService({
      apiKey: 're_live_abc',
      from: 'no-reply@example.com',
      fetch: listen as never,
      timeoutMs: 5,
    });

    const error = (await mail
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown)) as MailDeliveryError;

    // Injected budget rather than a real 8s wait: the deadline is proven by
    // driving the clock the transport uses, not by spending it.
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  test('an unreachable provider is a transport failure', async () => {
    const mail = service(() => Promise.reject(new TypeError('connection refused')));

    const error = (await mail
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown)) as MailDeliveryError;

    expect(error.reason).toBe('transport');
  });

  test('a 200 with no body is still a delivery, not a crash', async () => {
    const mail = service(() => Promise.resolve(new Response('', { status: 200 })));

    // Resend omitting the id would otherwise throw on `.json()` and report a
    // successful send as a failure, which trains people to ignore the report.
    expect(await mail.send(MESSAGE)).toEqual({ id: 'unknown', mode: 'resend' });
  });

  test('never attempts to send twice', async () => {
    const send = mock(() => Promise.resolve(new Response('{}', { status: 500 })));
    const mail = service(send as never);

    await mail.send(MESSAGE).catch(() => undefined);

    // One call, one attempt. The retry decision belongs to the person who asks
    // for another email; a loop here is how a provider outage becomes ours.
    expect(send).toHaveBeenCalledTimes(1);
  });
});
