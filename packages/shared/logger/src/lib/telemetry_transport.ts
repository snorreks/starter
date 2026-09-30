// packages/shared/logger/src/lib/telemetry_transport.ts
//
// HTTP transport for browser/native log forwarding.
//
// Client-reported context (user id, session id, user agent) is sent under
// `clientReported`, never as a top-level verified field. The server decides what
// is actually verified; the client's claim is data about the client.

import { type ClientReportedContext, type LogEvent } from '@starter/schemas/logging';
import type { TelemetryTransport } from './browser_logger.ts';

export type TelemetryPayload = LogEvent & {
  /** Self-asserted context, explicitly not server-verified. */
  clientReported?: ClientReportedContext;
};

export type HttpTelemetryTransportOptions = {
  endpoint: string;
  /** Optional bearer token; the server still re-verifies the session. */
  getAuthToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  context?: () => ClientReportedContext | undefined;
};

export const createHttpTelemetryTransport = (
  options: HttpTelemetryTransportOptions,
): TelemetryTransport => {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    send(event: LogEvent) {
      const payload: TelemetryPayload = { ...event };
      const reported = options.context?.();
      if (reported) {
        payload.clientReported = reported;
      }

      void (async () => {
        try {
          const token = await options.getAuthToken?.();
          await doFetch(options.endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify(payload),
            // Never let a log submission block navigation.
            keepalive: true,
          });
        } catch {
          // Telemetry is best-effort. A dropped log must never surface as an
          // application error, and must not retry into a loop.
        }
      })();
    },
  };
};
