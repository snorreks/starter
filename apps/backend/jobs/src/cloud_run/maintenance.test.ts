import { describe, expect, it } from 'bun:test';
import { retireSupabaseArtifacts } from './maintenance.ts';

describe('bounded R2 artifact retirement', () => {
  it('deletes only matching job objects and closes rows after R2 confirms removal', async () => {
    const rows = [
      { job_id: 'job_expired', output_key: 'media/v1/jobs/job_expired/attempts/attempt_a.mp4' },
      { job_id: 'job_foreign', output_key: 'media/v1/jobs/job_other/attempts/attempt_b.mp4' },
    ];
    const objects = new Set([rows[0]?.output_key, rows[1]?.output_key]);
    const closed: string[] = [];
    const result = await retireSupabaseArtifacts({
      queue: async (limit) => rows.slice(0, limit),
      media: {
        delete: async (key) => {
          if (Array.isArray(key)) {
            for (const item of key) {
              objects.delete(item);
            }
          } else {
            objects.delete(key);
          }
        },
        head: async (key) => (objects.has(key) ? ({ key } as R2Object) : null),
      },
      retire: async (jobId, key) => {
        closed.push(`${jobId}:${key}`);
        return true;
      },
      limit: 500,
    });
    expect(result).toEqual({ considered: 2, deleted: 1, refused: 1 });
    expect([...objects]).toEqual([rows[1]?.output_key]);
    expect(closed).toEqual(['job_expired:media/v1/jobs/job_expired/attempts/attempt_a.mp4']);
  });

  it('leaves the retirement queued when R2 still has the object', async () => {
    let closed = false;
    const key = 'media/v1/jobs/job_expired/attempts/attempt_a.mp4';
    const result = await retireSupabaseArtifacts({
      queue: async () => [{ job_id: 'job_expired', output_key: key }],
      media: { delete: async () => {}, head: async () => ({ key }) as R2Object },
      retire: async () => {
        closed = true;
        return true;
      },
    });
    expect(result).toEqual({ considered: 1, deleted: 0, refused: 1 });
    expect(closed).toBe(false);
  });
});
