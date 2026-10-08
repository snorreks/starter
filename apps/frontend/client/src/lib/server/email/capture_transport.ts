// apps/frontend/client/src/lib/server/email/capture_transport.ts
//
// The local mail inbox. Server-only, in memory, and impossible to run remotely.
//
// This is the transport every test in this repository uses. It exists because the
// alternative is worse in both directions: no transport at all, and the account
// lifecycle cannot be exercised; or a real provider key in a test environment,
// and a test run sends mail to a stranger.
//
// Three properties are load-bearing, and each has a test:
//
//   1. **Local only.** `isLocal: false` throws on construction. A Worker deployed
//      with `DEPLOYMENT_ENV=production` cannot hold an inbox even if someone
//      finds a way to request one.
//   2. **Isolated per run.** Messages live under an inbox id supplied by the
//      caller, which is the harness's `TEST_RUN_ID`. Two runs against one local
//      D1 see different inboxes, so a stale message from a previous run cannot
//      make today's verification test pass.
//   3. **Never logged.** A verification link is a credential. Nothing in this
//      file writes to a logger, and the read endpoint returns the token only to a
//      local caller.
//
// Memory, not D1, on purpose: an inbox is a debugging aid for the current run.
// Persisting tokens would put single-use credentials at rest in a database that
// outlives the run, which is strictly worse than losing them.

import { createId } from '@starter/utils';
import {
  MailCaptureRefused,
  type MailDelivery,
  type MailService,
  type OutboundEmail,
} from './mail.ts';

export interface CapturedEmail extends OutboundEmail {
  id: string;
  /** Epoch milliseconds. */
  capturedAt: number;
}

/** Bounded so a runaway loop in a test cannot exhaust the isolate. */
export const CAPTURE_INBOX_LIMIT = 100;

export interface CaptureMailService extends MailService {
  readonly mode: 'capture';
  readonly inboxId: string;
  /** Most recent last. */
  inbox(): readonly CapturedEmail[];
  /** The newest message addressed to `to`, or undefined. */
  latestFor(to: string): CapturedEmail | undefined;
  clear(): void;
}

export interface CaptureOptions {
  /**
   * Must be `true`. Not defaulted.
   *
   * A default of `false` would make forgetting the flag safe and getting it
   * wrong catastrophic, which is the wrong way round for a control.
   */
  isLocal: boolean;
  /** Namespace for this run. */
  inboxId: string;
  from: string;
  now?: () => number;
}

export const createCaptureMailService = (options: CaptureOptions): CaptureMailService => {
  if (!options.isLocal) {
    throw new MailCaptureRefused(
      'The mail capture inbox is a local-only capability. It refuses to run in a deployed ' +
        'environment, because an inbox that silently swallows verification and reset mail is ' +
        'indistinguishable from a working deployment until somebody cannot sign in.',
    );
  }

  const now = options.now ?? Date.now;
  const messages: CapturedEmail[] = [];

  return {
    mode: 'capture',
    inboxId: options.inboxId,
    from: options.from,

    async send(message: OutboundEmail): Promise<MailDelivery> {
      const captured: CapturedEmail = {
        ...message,
        id: createId('cap'),
        capturedAt: now(),
      };
      messages.push(captured);
      if (messages.length > CAPTURE_INBOX_LIMIT) {
        messages.splice(0, messages.length - CAPTURE_INBOX_LIMIT);
      }
      // `id` only. No recipient, no subject, no body, no token: this is the one
      // place a caller might be tempted to log the whole message, and a
      // verification link in a log is a live credential.
      return { id: captured.id, mode: 'capture' };
    },

    inbox: () => messages,

    latestFor(to: string): CapturedEmail | undefined {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.to === to) {
          return message;
        }
      }
      return undefined;
    },

    clear: () => {
      messages.length = 0;
    },
  };
};
