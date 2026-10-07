import { createAdminDatabaseClient } from '@starter/database/supabase';
import type { JobsEnv } from '../env.ts';

export const MAX_ARTIFACT_RETIREMENTS = 100;

export interface ArtifactRetirement {
  job_id: string;
  output_key: string;
}

export const retireSupabaseArtifacts = async (options: {
  queue: (limit: number) => Promise<readonly ArtifactRetirement[]>;
  retire: (jobId: string, outputKey: string) => Promise<boolean>;
  media: Pick<R2Bucket, 'delete' | 'head'>;
  limit?: number;
}) => {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? MAX_ARTIFACT_RETIREMENTS), 1),
    MAX_ARTIFACT_RETIREMENTS,
  );
  // Queueing durably increments runs before any validation or storage refusal.
  const queued = await options.queue(limit);
  if (!Array.isArray(queued) || queued.length > limit) {
    throw new Error('Supabase returned an unbounded artifact retirement batch.');
  }
  let deleted = 0;
  let refused = 0;
  for (const item of queued) {
    const key = `media/v1/jobs/${item.job_id}/attempts/`;
    if (
      !/^job_[A-Za-z0-9_-]{1,60}$/.test(item.job_id) ||
      !item.output_key.startsWith(key) ||
      item.output_key.slice(key.length, -4).includes('..') ||
      !/^media\/v1\/jobs\/job_[A-Za-z0-9_-]{1,60}\/attempts\/[A-Za-z0-9_.-]{1,128}\.mp4$/.test(
        item.output_key,
      )
    ) {
      refused += 1;
      continue;
    }
    await options.media.delete(item.output_key);
    if (await options.media.head(item.output_key)) {
      refused += 1;
      continue;
    }
    if (await options.retire(item.job_id, item.output_key)) {
      deleted += 1;
    } else {
      refused += 1;
    }
  }
  return { considered: queued.length, deleted, refused };
};

/** R2-aware half of Supabase maintenance; SQL Cron owns database-only history. */
export const runSupabaseArtifactRetention = async (env: JobsEnv) => {
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ['MEDIA', env.MEDIA],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Supabase artifact retention configuration is incomplete: ${missing.join(', ')}.`,
    );
  }
  const config = env as JobsEnv &
    Required<
      Pick<JobsEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY' | 'MEDIA'>
    >;
  const admin = createAdminDatabaseClient({
    url: config.SUPABASE_URL,
    anonKey: config.SUPABASE_ANON_KEY,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  });
  return retireSupabaseArtifacts({
    media: config.MEDIA,
    queue: async (limit) => {
      const { data, error } = await admin.rpc('queue_expired_job_artifacts', {
        p_cutoff: new Date().toISOString(),
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) {
        throw new Error('Postgres could not queue expired media artifacts.');
      }
      return data;
    },
    retire: async (jobId, outputKey) => {
      const { data, error } = await admin.rpc('retire_job_artifact', {
        p_job_id: jobId,
        p_output_key: outputKey,
      });
      if (error) {
        throw new Error('Postgres could not close the media artifact retirement.');
      }
      return data === true;
    },
  });
};
