import type { JobFixture } from './job.ts';

/** Versioned private-media layout shared by provisioning and the runtime. */
export const MEDIA_KEY_PREFIX = 'media/v1';

/** The object key the encode Workflow reads for a named fixture. */
export const mediaFixtureKey = (fixture: JobFixture): string =>
  `${MEDIA_KEY_PREFIX}/fixtures/${fixture}.mp4`;
