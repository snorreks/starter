// scripts/tests/deployment_compatibility.test.ts
//
// What may change together, and what a rollback does and does not undo.
//
// The three facts this file encodes are all consequences of the same asymmetry:
// a Cloudflare deployment versions *code* and leaves everything else alone. The
// schema, the stored media and any running Workflow instance are not part of a
// Worker version, so "roll back" restores exactly one of the four things a deploy
// changed.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROCESSOR_PROTOCOL_ID } from '@starter/schemas/jobs';
import { verifyTinyJob } from '../src/deploy/apply.ts';
import {
  CONTAINER_PROFILES,
  imageProtocolProblem,
  RETAINED_PREVIOUS_IMAGES,
  rollbackImagePlan,
  targetCompatibilityProblem,
  workflowSerializationNote,
} from '../src/deploy/compatibility.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

const computeTarget = (): ResolvedTarget => encodeTarget();

/** The root `package.json` scripts, so a remedy naming a command can be checked. */
const ROOT_SCRIPTS: string[] = Object.keys(
  (
    JSON.parse(
      // Through `REPO_ROOT`, like every other repository path in this repository: a
      // hand-counted `../../..` is silent and reads as a missing file.
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
  ).scripts ?? {},
);

const encodeTarget = (overrides: Partial<ResolvedTarget['compute']> = {}): ResolvedTarget => ({
  environment: 'staging',
  project: 'starter',
  accountId: 'a'.repeat(32),
  workerName: 'starter-staging',
  d1DatabaseId: 'db-staging',
  origin: 'https://staging.example',
  wranglerConfig: 'apps/frontend/client/wrangler.jsonc',
  jobsWranglerConfig: 'apps/backend/jobs/wrangler.jsonc',
  compute: {
    enabled: true,
    profile: 'encode',
    jobsWorkerName: 'starter-jobs-staging',
    mediaBucketName: 'starter-media-staging',
    encodeWorkflowName: 'starter-encode-staging',
    maintenanceWorkflowName: 'starter-maintenance-staging',
    containerImage: '../media/Dockerfile',
    imageProtocol: PROCESSOR_PROTOCOL_ID,
    containerProfile: 'basic',
    ...overrides,
  },
  mailFrom: 'noreply@staging.example',
  nativeApiOrigin: null,
  requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'],
  requiredVarNames: ['DEPLOYMENT_ENV', 'BETTER_AUTH_URL', 'MAIL_FROM', 'RELEASE'],
});

describe('a coherent encode environment is accepted', () => {
  test('every identity present, a known profile, a matching protocol', () => {
    expect(targetCompatibilityProblem(encodeTarget())).toBeNull();
  });

  test('a disabled profile needs no compute identity at all', () => {
    const webOnly = encodeTarget({
      enabled: false,
      profile: 'disabled',
      jobsWorkerName: null,
      mediaBucketName: null,
      encodeWorkflowName: null,
      maintenanceWorkflowName: null,
      containerImage: null,
      imageProtocol: null,
      containerProfile: null,
    });
    expect(targetCompatibilityProblem(webOnly)).toBeNull();
  });
});

describe('an incoherent compute environment is refused before anything is mutated', () => {
  test('an unknown container profile names the ones the platform offers', () => {
    const problem = targetCompatibilityProblem(encodeTarget({ containerProfile: 'enormous' }));
    expect(problem?.reason).toContain('"enormous"');
    expect(problem?.remedy).toContain(CONTAINER_PROFILES[0]);
  });

  test('"encode" with no image and no bucket is refused, and both remedies are offered', () => {
    // Not a partial deployment. With the profile on, `/api/jobs` admits a job that
    // can never complete, which is worse than not offering it.
    const problem = targetCompatibilityProblem(
      encodeTarget({ containerImage: null, mediaBucketName: null, imageProtocol: null }),
    );
    expect(problem?.reason).toContain('--media-bucket');
    expect(problem?.reason).toContain('--image');
    // Every flag in the remedy must exist. It used to name `--provision-compute`,
    // which no command implements, so the one command offered for an incoherent
    // compute environment could not be typed.
    for (const flag of [
      '--jobs-worker',
      '--media-bucket',
      '--encode-workflow',
      '--maintenance-workflow',
      '--image ',
      '--image-protocol',
      '--container-profile',
      '--jobs-profile encode',
    ]) {
      expect(problem?.remedy ?? '').toContain(flag);
    }
    expect(problem?.remedy ?? '').not.toContain('--provision-compute');

    // Every command the remedy names must exist in package.json. A remedy naming a
    // command that was never implemented is worse than no remedy, because it looks
    // like one.
    for (const command of (problem?.remedy ?? '').match(/bun run [a-z:-]+/g) ?? []) {
      const name = command.replace('bun run ', '');
      expect(ROOT_SCRIPTS).toContain(name);
    }
    // Turning it off is offered too, because for a web-only environment that is the
    // honest configuration rather than an error to work around.
    expect(problem?.remedy).toContain('--jobs-profile disabled');
  });

  test('a missing sender is refused, because a release without mail cannot confirm an account', () => {
    const problem = targetCompatibilityProblem({ ...encodeTarget(), mailFrom: '' });
    expect(problem?.reason ?? '').toContain('MAIL_FROM');
    expect(problem?.remedy ?? '').toContain('verified');
  });

  test('a native origin that is not an absolute https URL is refused', () => {
    // A packaged binary cannot be re-pointed after signing, so this is the last
    // moment it can be corrected.
    const problem = targetCompatibilityProblem({
      ...encodeTarget(),
      nativeApiOrigin: 'http://staging.example/api',
    });
    expect(problem?.reason).toContain('native API origin');
  });

  test('a project that ships no packaged client is not asked for an origin', () => {
    expect(targetCompatibilityProblem({ ...encodeTarget(), nativeApiOrigin: null })).toBeNull();
  });
});

describe('an active Workflow may not be left speaking a different protocol', () => {
  test('a first deploy has nothing running, so there is nothing to refuse', () => {
    expect(imageProtocolProblem(encodeTarget(), null)).toBeNull();
  });

  test('a configured protocol this source does not speak is refused before the deploy', () => {
    const problem = imageProtocolProblem(encodeTarget({ imageProtocol: 'sample-v2' }), null);
    expect(problem?.reason).toContain(PROCESSOR_PROTOCOL_ID);
    expect(problem?.remedy).toContain('frozen');
  });

  test('a running image on another protocol names the phased remedy', () => {
    // The failure this prevents appears *inside jobs accepted before the deploy
    // started*, which is the worst place to discover it: it looks like a scheduler
    // or retry bug, not a release problem.
    const problem = imageProtocolProblem(encodeTarget(), { imageProtocol: 'sample-v0' });
    expect(problem?.reason).toContain('sample-v0');
    expect(problem?.remedy).toContain('--only jobs');
    expect(problem?.remedy).toContain('does not roll the image back');
  });

  test('a release that recorded no protocol is treated as unproven, not as compatible', () => {
    // "The image was built from this repository" is an assumption, not a fact, for a
    // release predating the recorded identity — and it is the assumption that lets a
    // protocol change reach production unnoticed.
    const problem = imageProtocolProblem(encodeTarget(), { imageProtocol: null });
    expect(problem?.reason).toContain('recorded no image protocol');
    expect(problem?.remedy).toContain('--jobs-profile encode');
  });

  test('a matching deployed image is accepted', () => {
    expect(
      imageProtocolProblem(encodeTarget(), { imageProtocol: PROCESSOR_PROTOCOL_ID }),
    ).toBeNull();
  });

  test('a disabled profile is never in this conversation', () => {
    const webOnly = encodeTarget({ enabled: false, profile: 'disabled', imageProtocol: null });
    expect(imageProtocolProblem(webOnly, { imageProtocol: 'sample-v0' })).toBeNull();
  });
});

describe('image retention and what a rollback restores', () => {
  const release = (sha: string, digest: string) => ({
    sourceSha: sha,
    imageDigest: digest,
    recordedAt: '2026-10-01T00:00:00.000Z',
  });

  test('the current image is named and the retained ones follow it', () => {
    const plan = rollbackImagePlan([
      release('aaa', 'sha256:3'),
      release('bbb', 'sha256:2'),
      release('ccc', 'sha256:1'),
    ]);

    expect(plan.current).toBe('sha256:3');
    expect(plan.rollbackTo).toEqual(['sha256:2', 'sha256:1']);
    expect(plan.supported).toBe(true);
  });

  test('two previous images are retained, which is what makes a rollback past a bad one work', () => {
    expect(RETAINED_PREVIOUS_IMAGES).toBeGreaterThan(1);
    const plan = rollbackImagePlan([
      release('aaa', 'sha256:4'),
      release('bbb', 'sha256:3'),
      release('ccc', 'sha256:2'),
      release('ddd', 'sha256:1'),
    ]);
    expect(plan.rollbackTo).toHaveLength(RETAINED_PREVIOUS_IMAGES);
  });

  test('a history longer than the retention is reported as unsupported', () => {
    const plan = rollbackImagePlan([
      release('a', 'sha256:5'),
      release('b', 'sha256:4'),
      release('c', 'sha256:3'),
      release('d', 'sha256:2'),
      release('e', 'sha256:1'),
    ]);
    expect(plan.rollbackTo).toHaveLength(RETAINED_PREVIOUS_IMAGES);
    expect(plan.supported).toBe(false);
  });

  test('a release with no image contributes nothing to a rollback plan', () => {
    const plan = rollbackImagePlan([
      release('aaa', 'sha256:1'),
      { ...release('bbb', ''), imageDigest: null },
    ]);
    expect(plan.current).toBe('sha256:1');
    expect(plan.rollbackTo).toEqual([]);
  });

  test('nothing recorded means nothing to roll back to, and that is reported rather than assumed', () => {
    const plan = rollbackImagePlan([]);
    expect(plan.current).toBeNull();
    expect(plan.rollbackTo).toEqual([]);
    expect(plan.supported).toBe(true);
  });
});

describe('the apply pipeline checks the protocol the last release recorded', () => {
  /**
   * A fetch stub that walks the whole verify path: admit, poll to succeeded, fetch
   * output. Ordered by URL rather than by call count, because the order is the thing
   * under test and a counter would encode the assumption being checked.
   */
  const walkToSuccess = (output: {
    ok: boolean;
    status: number;
    bytes: number;
  }): typeof globalThis.fetch =>
    (async (url: string) => {
      if (url.endsWith('/api/jobs')) {
        return { ok: true, status: 202, json: async () => ({ id: 'job-1', status: 'pending' }) };
      }
      if (url.endsWith('/output')) {
        return {
          ok: output.ok,
          status: output.status,
          arrayBuffer: async () => new ArrayBuffer(output.bytes),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'job-1', status: 'succeeded', outputAvailable: true }),
      };
    }) as unknown as typeof globalThis.fetch;

  test('an empty output is a failure with its own message, not "0 bytes fetched"', async () => {
    // The distinction matters to whoever reads the release record: "0 bytes were
    // fetched" reads as a successful fetch of nothing.
    const result = await verifyTinyJob(
      computeTarget(),
      walkToSuccess({ ok: true, status: 200, bytes: 0 }),
      { token: 'session-token' },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('was empty');
    expect(result.detail).not.toContain('0 bytes');
  });

  test('a real output passes, and reports how much it fetched', async () => {
    const result = await verifyTinyJob(
      computeTarget(),
      walkToSuccess({ ok: true, status: 200, bytes: 4096 }),
      { token: 'session-token' },
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('4096 bytes');
  });

  test('a network error while fetching the output fails the verification', async () => {
    // It used to reject out of `apply` entirely, so a deploy that had already
    // succeeded ended in a stack trace instead of a recorded failure.
    const failing = (() =>
      Promise.reject(new Error('connection reset'))) as unknown as typeof globalThis.fetch;

    const result = await verifyTinyJob(computeTarget(), failing, { token: 'session-token' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('connection reset');
  });

  test('a job that cannot be admitted fails the release', async () => {
    const refusing = {
      ok: false,
      status: 429,
      json: async () => ({ error: 'budget exceeded' }),
    };

    const result = await verifyTinyJob(
      computeTarget(),
      (async () => refusing) as unknown as typeof globalThis.fetch,
      { token: 'session-token' },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('429');
  });

  test('a compute profile with no session token says what was and was not proved', async () => {
    // No `--with-job` suggestion any more: no such flag exists, so the only remedy
    // offered was a command that could not be run.
    const result = await verifyTinyJob(computeTarget(), (async () => ({
      ok: true,
      status: 200,
    })) as unknown as typeof globalThis.fetch);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('NOT the full proof');
    expect(result.detail).not.toContain('--with-job');
    expect(result.detail).toContain('cannot stand in for a user session');
  });
});

describe('serialisation is a repository guarantee, not a provider one', () => {
  test('the note names the guarantee and the ways around it', () => {
    const note = workflowSerializationNote();
    expect(note).toContain('one repository');
    expect(note).toContain('NOT a provider-wide lock');
    // The three ways the guarantee does not hold, named so an operator does not have
    // to discover them. Asserted as whole clauses: a generic `account` substring also
    // matches "Cloudflare account", so deleting the bypass clause would have passed.
    expect(note).toContain('operator laptop');
    expect(note).toContain('another repository pointed at the same account');
    expect(note).toContain('a second account holder deploying by hand');
  });
});
