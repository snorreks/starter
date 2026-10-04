// apps/frontend/client/src/lib/composition/jobs.ts
//
// The web application's jobs wiring.
//
// The pattern is `notes.ts` exactly, and repeating it is the point: the shared
// feature ships a View, a ViewModel and a service; constructing one needs an
// `ApiTransport`, and *which* transport is the host's decision. This file is where
// the web application's answer lives, and the route imports from here rather than
// reaching for a transport of its own.
//
// One service for the application
// ------------------------------
// `JobsService` holds no state — the job list, the poll timer and the held result
// all live in the ViewModel that owns the screen — so a single instance cannot
// disagree with a second one. It is created here rather than in the feature
// package for exactly that reason: the feature must not know which host it runs
// in.
//
// It takes an `ArtifactTransport` rather than an `ApiTransport`, and that is a
// compile-time fact rather than a runtime one: this transport is the one that can
// return the encoded bytes, because it is the same `HttpTransport` the JSON calls
// use and it carries the session cookie on the byte request as well.

import { JobsService, JobsViewModel } from '@starter/features/jobs';
import type { JobDto, LatestMaintenance } from '@starter/schemas/jobs';
import { webTransport } from './transport.ts';

export const jobsService = new JobsService({
  transport: webTransport,
  className: 'WebJobsService',
});

export interface JobsComposition {
  jobs?: JobsService;
  /** The list the SSR load already produced, so the first paint is not empty. */
  initialJobs?: readonly JobDto[];
  initialMaintenance?: LatestMaintenance | null;
  /** Set when the server already knows the profile is switched off. */
  unavailableMessage?: string;
}

export const getJobsViewModel = (options: JobsComposition = {}): JobsViewModel =>
  new JobsViewModel({
    jobs: options.jobs ?? jobsService,
    ...(options.initialJobs === undefined ? {} : { initialJobs: options.initialJobs }),
    ...(options.initialMaintenance === undefined
      ? {}
      : { initialMaintenance: options.initialMaintenance }),
    ...(options.unavailableMessage === undefined
      ? {}
      : { unavailableMessage: options.unavailableMessage }),
  });
