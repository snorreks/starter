// packages/shared/utils/src/lib/common/error.ts
//
// One error type across planes. The API, the client transport and the CLI all
// classify failures through `AppErrorType` so a "the server said 401" and a
// "the fetch never resolved" are distinguishable without string matching.

export const APP_ERROR_TYPES = [
  'unknown',
  'network',
  'timeout',
  'aborted',
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'conflict',
  'rate_limited',
  'server',
  'unavailable',
] as const;

export type AppErrorType = (typeof APP_ERROR_TYPES)[number];

export class AppError extends Error {
  readonly errorType: AppErrorType;
  readonly status: number | undefined;
  /** Field-level messages for form rendering, keyed by input name. */
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;

  constructor(
    errorType: AppErrorType,
    message: string,
    options: { cause?: unknown; status?: number; fieldErrors?: Record<string, string> } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.errorType = errorType;
    this.status = options.status;
    this.cause = options.cause;
    this.fieldErrors = options.fieldErrors;
  }
}

/** Map an HTTP status to the error type the UI should react to. */
export const errorTypeForStatus = (status: number): AppErrorType => {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 422 || status === 400) {
    return 'validation';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'unknown';
};

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

/** Normalize anything thrown into an `AppError` without losing the original. */
export const toAppError = (value: unknown, fallbackMessage = 'Something went wrong.'): AppError => {
  if (isAppError(value)) {
    return value;
  }

  if (value instanceof DOMException && value.name === 'AbortError') {
    return new AppError('aborted', 'The request was cancelled.', { cause: value });
  }

  if (value instanceof TypeError) {
    // `fetch` rejects with TypeError for DNS/connection failures.
    return new AppError('network', 'Could not reach the server.', { cause: value });
  }

  if (value instanceof Error) {
    return new AppError('unknown', value.message || fallbackMessage, { cause: value });
  }

  return new AppError('unknown', fallbackMessage, { cause: value });
};

/** True when a rejection is just a cancelled request, not a failure to report. */
export const isAbortError = (value: unknown): boolean =>
  (isAppError(value) && value.errorType === 'aborted') ||
  (value instanceof DOMException && value.name === 'AbortError') ||
  (value instanceof Error && value.name === 'AbortError');
