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
import { PROCESSOR_PROTOCOL_ID } from '@starter/schemas/jobs';
import {
  CONTAINER_PROFILES,
  imageProtocolProblem,
  RETAINED_PREVIOUS_IMAGES,
  rollbackImagePlan,
  targetCompatibilityProblem,
  workflowSerializationNote,
} from '../src/deploy/compatibility.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

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
    expect(problem?.remedy).toContain('--provision-compute');
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

describe('serialisation is a repository guarantee, not a provider one', () => {
  test('the note names the guarantee and the ways around it', () => {
    const note = workflowSerializationNote();
    expect(note).toContain('one repository');
    expect(note).toContain('NOT a provider-wide lock');
    // The three ways the guarantee does not hold, named so an operator does not have
    // to discover them.
    expect(note).toContain('laptop');
    expect(note).toContain('another repository');
    expect(note).toContain('account');
  });
});
