// apps/frontend/client/src/lib/server/email/mail.ts
//
// The application's whole email surface: three types, one factory, one refusal.
//
// Why a hand-written capability rather than a library
// ---------------------------------------------------
// Verification and password reset are the only two things this application ever
// sends, and there is exactly one production provider for them. A provider
// interface with registration, middleware, retries, per-provider options and a
// queue would be more code than the two emails, and every part of it would be
// untested because nothing would call it.
//
// So: an interface with one method, two implementations, and no framework.
//
// The rule that matters
// ---------------------
// A **local** environment captures mail in memory. Any other environment sends
// it through Resend and cannot be configured to do the former.
//
// That is enforced structurally rather than by convention: `resolveMail`
// returns a refusal for a remote environment that has no API key, and refuses
// explicitly if anything asks for capture outside local. It is therefore not
// possible to deploy this Worker with the capture inbox switched on, which is
// the failure that would look like a working sign-up while delivering nothing
// to anybody.
//
// Secrets
// -------
// Nothing here logs a recipient's address, a message body, or a token. A
// verification link *is* a password reset with extra steps, so a token in an
// application log is a credential in a log aggregator. Failures are reported by
// reason code only.

/** Which implementation is in use. Part of the readiness report, never a secret. */
export type MailMode = 'resend' | 'capture';

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text. Always present: a verification mail must survive a blocked image. */
  text: string;
}

export interface MailDelivery {
  /** Provider or capture-local identifier. Useful for support, not a secret. */
  id: string;
  mode: MailMode;
}

/**
 * Why a send failed.
 *
 * `retryable` is a fact about the provider's answer, not advice about what this
 * application should do next. It exists so an operator reading a log can tell a
 * typo'd `MAIL_FROM` (never retry it) from Resend being briefly unavailable
 * (someone will retry it by re-requesting the email). This application does not
 * retry on its own: an unbounded retry loop on the sign-up path is a way to turn
 * a provider outage into an outage here.
 */
export type MailFailureReason = 'not_configured' | 'rejected' | 'timeout' | 'transport';

export class MailDeliveryError extends Error {
  readonly reason: MailFailureReason;
  readonly retryable: boolean;

  constructor(reason: MailFailureReason, retryable: boolean, message: string) {
    super(message);
    this.name = 'MailDeliveryError';
    this.reason = reason;
    this.retryable = retryable;
  }
}

export interface MailService {
  readonly mode: MailMode;
  /** The `From` address this service sends as, for the readiness report. */
  readonly from: string;
  /** Resolves only once the provider has accepted the message. */
  send(message: OutboundEmail): Promise<MailDelivery>;
}

/** Raised by a transport that must not run outside a local environment. */
export class MailCaptureRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailCaptureRefused';
  }
}

/** The bindings mail configuration reads. A subset of `AppEnv`, to stay testable. */
export interface MailEnv {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  TEST_RUN_ID?: string;
}

export type MailResolution =
  | { ok: true; mode: MailMode; apiKey?: string; from: string; inbox: string }
  | { ok: false; problem: string; remedy: string };

/** Address used by the local capture inbox. Never reached by a real send. */
export const CAPTURE_FROM = 'no-reply@starter.invalid';

/**
 * Decide how mail is delivered, or refuse to start.
 *
 * `isLocal` is the same `DEPLOYMENT_ENV`-derived flag the rest of the Worker
 * uses, passed in rather than re-derived: one authority for "is this local", so
 * there is no second rule that can disagree with the first.
 */
export const resolveMail = (env: MailEnv, isLocal: boolean): MailResolution => {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();

  if (isLocal) {
    // Capture regardless of whether a key happens to be present. A developer's
    // machine must not be able to send real mail to real people because a key
    // leaked into a `.env`, and "local" is the only place this is decided.
    return {
      ok: true,
      mode: 'capture',
      from: from !== undefined && from.length > 0 ? from : CAPTURE_FROM,
      // The run id is the harness's identity, so two runs sharing one local D1
      // still cannot read each other's mail. `TEST_RUN_ID` already exists for
      // exactly this purpose: proving a request reached *this* process.
      inbox: env.TEST_RUN_ID?.trim() ?? 'local',
    };
  }

  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      problem:
        'RESEND_API_KEY is not set, so verification and password reset have nowhere to go. ' +
        'Every sign-up would report success and deliver nothing, which is worse than a ' +
        'refusal: the accounts exist and nobody can ever complete them. Deployed environments ' +
        'are not permitted to use the local capture inbox.',
      remedy: 'Set it with: wrangler secret put RESEND_API_KEY --env staging (or production).',
    };
  }

  if (from === undefined || from.length === 0) {
    return {
      ok: false,
      problem: 'MAIL_FROM is not set, so the sender address is unknown.',
      remedy:
        'Set MAIL_FROM to an address your Resend domain is verified for, e.g. ' +
        '"Starter <no-reply@example.com>".',
    };
  }

  return { ok: true, mode: 'resend', apiKey, from, inbox: '' };
};
