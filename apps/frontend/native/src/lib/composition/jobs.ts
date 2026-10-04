// apps/frontend/native/src/lib/composition/jobs.ts
//
// The native host's jobs service. Three lines, and that is the point.
//
// `JobsService`, `JobsViewModel`, `JobsView` and every row are the ones the web
// application renders, from `@starter/features`. What differs is the transport
// behind them: one browser with a cookie and one shell with a bearer token.
//
// The consequence worth stating is about media. A native shell's credential is a
// header on a request this transport makes, and a `<video src>` would issue its
// own request without it. So the result is fetched through the transport and turned
// into a Blob by the feature — no token in a URL, no capability route to revoke,
// and the bytes stop being reachable the moment the token does.

import { JobsService, JobsViewModel } from '@starter/features/jobs';
import { nativeTransport } from './session.ts';

export const jobsService = new JobsService({
  transport: nativeTransport,
  className: 'NativeJobsService',
});

export const getJobsViewModel = (): JobsViewModel => new JobsViewModel({ jobs: jobsService });
