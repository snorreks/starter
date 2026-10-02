// apps/frontend/client/src/lib/server/email/resend_transport.ts
//
// The production mail transport: Resend over `fetch`.
//
// One HTTP call, one timeout, no retries, no queue. Those are decisions, not
// omissions:
//
//   * **No retries.** A retry loop on the sign-up path turns a provider blip into
//     a self-inflicted outage, and a verification mail is cheap for a human to
//     request twice. The caller reports the failure and the user re-requests.
//   * **A timeout.** A Worker request has a wall clock. Without one, a provider
//     that accepts the connection and then stalls holds the sign-up request
//     until the platform kills it, and the user sees a platform error rather
//     than a reason.
//   * **No SDK.** Resend's API is one POST. The SDK would add a dependency and a
//     second place for the API key to appear.

import {
  type MailDelivery,
  MailDeliveryError,
  type MailService,
  type OutboundEmail,
} from './mail.ts';

/** Generous for a single POST, short enough to fail inside a Worker request. */
export const RESEND_TIMEOUT_MS = 8_000;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type ResendFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  fetch?: ResendFetch;
  timeoutMs?: number;
}

interface ResendResponse {
  id?: string;
  message?: string;
  name?: string;
}

export const createResendMailService = (options: ResendOptions): MailService => {
  const send = options.fetch ?? (globalThis.fetch as unknown as ResendFetch);
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;

  if (typeof send !== 'function') {
    throw new MailDeliveryError(
      'not_configured',
      false,
      'No fetch implementation is available for the Resend transport.',
    );
  }

  return {
    mode: 'resend',
    from: options.from,

    async send(message: OutboundEmail): Promise<MailDelivery> {
      let response: Response;
      try {
        response = await send(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // `AbortSignal.timeout` aborts with a `TimeoutError` DOMException; a
        // refused connection is a plain `TypeError`. They mean different things
        // to whoever reads the log, so they are not collapsed.
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        throw new MailDeliveryError(
          timedOut ? 'timeout' : 'transport',
          true,
          timedOut
            ? `Resend did not respond within ${timeoutMs}ms.`
            : 'Resend could not be reached.',
        );
      }

      if (!response.ok) {
        const detail = await readProviderDetail(response);
        // 4xx means this message will never be accepted as written: a bad
        // sender, a bad address, a quota that only a person can raise. Retrying
        // is pointless. 5xx and 429 are the provider's problem and may pass.
        const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw new MailDeliveryError(
          rejected ? 'rejected' : 'transport',
          !rejected,
          `Resend refused the message with ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
        );
      }

      const body = (await response.json().catch(() => ({}))) as ResendResponse;
      return { id: body.id ?? 'unknown', mode: 'resend' };
    },
  };
};

/**
 * Resend's own error text, when it is short and safe.
 *
 * Bounded because this string reaches a log. A provider that echoes the request
 * back would otherwise put the recipient's address into the application's logs,
 * and an unbounded provider message is an unbounded log line.
 */
const readProviderDetail = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as ResendResponse;
    const detail = body.message ?? body.name;
    return typeof detail === 'string' && detail.length > 0 ? detail.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
};
