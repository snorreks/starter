// scripts/src/deploy/compatibility.ts
//
// Whether the thing already running can talk to the thing about to be deployed.
//
// This is a separate question from "did the deploy succeed", and it is the one
// that decides whether a *rollback* is safe. Three facts about a Cloudflare
// deployment make it its own question:
//
//   1. **A Worker rollback does not undo a D1 migration.** Wrangler versions the
//      code; it does not version the schema. Rolling the Worker back after
//      `apply` migrated leaves the previous release running against the newer
//      schema, and the only safe move is a *forward* migration.
//   2. **A Worker rollback does not undo R2 output either.** Encoded media written
//      by the newer release stays, and anything that reads it — a download link, a
//      retention sweep, a second user's copy — is unaffected by which Worker
//      answers.
//   3. **Workflows and containers are separately versioned, and they are not
//      atomic with the web Worker.** An in-flight `EncodeWorkflow` instance holds
//      an image reference. Publishing a new image whose protocol the running
//      Workflow does not expect produces failures *inside a job that was accepted
//      before the deploy started* — the worst place to discover it, because the
//      job looks like a scheduler or retry bug.
//
// So the rules below are about what may change together, and they are computed
// offline from configuration and from a release record. Nothing here contacts a
// provider, which is what lets `deploy plan` refuse on a fork.

import { PROCESSOR_PROTOCOL_ID } from '@starter/schemas/jobs';
import type { ResolvedTarget } from './target.ts';

/**
 * Container profiles the platform documents, with the numbers the design quoted.
 *
 * Recorded rather than fetched: `deploy plan` has to be answerable offline, and a
 * compatibility rule that depends on a network call is a rule that cannot refuse
 * before a mutation. `docs/cloudflare.md` carries the link and the date this was
 * checked; the set is only a *bound* — a profile outside it is refused because the
 * deployment would fail with an opaque provider error, not because this list is
 * authoritative about what exists.
 */
export const CONTAINER_PROFILES = [
  'lite',
  'basic',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
] as const;

export type ContainerProfile = (typeof CONTAINER_PROFILES)[number];

/**
 * How many *previous* images stay available for a supported rollback.
 *
 * Not "one", which is the common mistake: publishing image N+1 then garbage-
 * collecting the one before it means the rollback documented in docs/deployment.md
 * stops being available at exactly the moment somebody needs it. Not "all" either,
 * which is unbounded cost on a path this template demonstrates rather than operates.
 *
 * Two previous images is the smallest number that lets both "roll back to the last
 * release" and "roll back past a bad last release" work.
 */
export const RETAINED_PREVIOUS_IMAGES = 2;

/** The current image plus everything a supported rollback can return to. */
export const RETAINED_IMAGE_REVISIONS = RETAINED_PREVIOUS_IMAGES + 1;

export interface CompatibilityProblem {
  reason: string;
  remedy: string;
}

/**
 * Whether the resolved target's own configuration is internally coherent.
 *
 * Runs before any mutation, on a plan, on a fork, with no credential. Everything
 * here is a *configuration* check: it can tell you the deployment is about to
 * contradict itself, and it cannot tell you what is deployed.
 */
export const targetCompatibilityProblem = (target: ResolvedTarget): CompatibilityProblem | null => {
  const { compute } = target;

  // ── profile ────────────────────────────────────────────────────────────────
  if (compute.enabled) {
    if (
      compute.containerProfile === null ||
      !(CONTAINER_PROFILES as readonly string[]).includes(compute.containerProfile)
    ) {
      return {
        reason:
          `The ${target.environment} jobs profile is "encode" but its container profile is ` +
          `${
            compute.containerProfile === null ? 'not configured' : `"${compute.containerProfile}"`
          }.`,
        remedy:
          'Choose a profile the platform offers and that the fixture was measured on:\n' +
          `  ${CONTAINER_PROFILES.join(', ')}\n` +
          '  apps/backend/media/README.md records the measurements behind "basic".',
      };
    }
  }

  // ── every identity the encode path needs ───────────────────────────────────
  if (compute.enabled) {
    const missing: string[] = [];
    if (compute.jobsWorkerName === null) {
      missing.push('--jobs-worker');
    }
    if (compute.mediaBucketName === null) {
      missing.push('--media-bucket');
    }
    if (compute.encodeWorkflowName === null) {
      missing.push('--encode-workflow');
    }
    if (compute.maintenanceWorkflowName === null) {
      missing.push('--maintenance-workflow');
    }
    if (compute.containerImage === null) {
      missing.push('--image');
    }
    if (compute.imageProtocol === null) {
      missing.push('--image-protocol');
    }

    if (missing.length > 0) {
      return {
        reason:
          `The ${target.environment} jobs profile is "encode", but the identities the encode ` +
          `path needs are missing: ${missing.join(', ')}.`,
        remedy:
          'A profile of "encode" with no image and no bucket is not a partial deployment: it\n' +
          '  admits jobs that can never complete. Either configure the compute half:\n' +
          `    bun run deploy:configure -- --env ${target.environment} --provision-compute\n` +
          '  or turn it off, which is the honest state for a web-only environment:\n' +
          `    bun run deploy:configure -- --env ${target.environment} --jobs-profile disabled`,
      };
    }
  }

  // ── mail ───────────────────────────────────────────────────────────────────
  // `''` rather than `null`: `resolveTarget` normalises an absent address to the
  // empty string so the field stays a string, and a check written against `null`
  // alone would pass a target with no sender at all.
  if (target.mailFrom.trim() === '') {
    return {
      reason: `No MAIL_FROM is configured for ${target.environment}.`,
      remedy:
        'The application sends verification, recovery and sign-in mail, so a release without a\n' +
        '  sender is one where nobody can confirm an account. Configure it:\n' +
        `    bun run deploy:configure -- --env ${target.environment} --mail-from <verified@host>\n` +
        '  The address must be on a domain Resend has verified, or delivery fails in a way that\n' +
        '  reads as a deployment problem.',
    };
  }

  // ── native ─────────────────────────────────────────────────────────────────
  // Not refused when absent. The native app is a client, and a project with no
  // packaged app is a legitimate configuration — but a *wrong* origin is refused,
  // because a packaged binary cannot be re-pointed after it is signed.
  if (target.nativeApiOrigin !== null && !/^https:\/\/[^/?#]+$/.test(target.nativeApiOrigin)) {
    return {
      reason: `The native API origin for ${target.environment} is "${target.nativeApiOrigin}".`,
      remedy:
        'It must be an absolute https URL with no path, query or fragment. It is compiled into\n' +
        '  a packaged binary, so it cannot be corrected after release.',
    };
  }

  return null;
};

/**
 * Whether this source's protocol is what the *deployed* image speaks.
 *
 * `deployed` is the recorded release, or `null` for a first deploy. A mismatch is
 * refused with a different remedy from an absent value: an absent value is a first
 * deploy and nothing is running, while a mismatch is a live environment whose
 * running instances were started by the previous release.
 */
export const imageProtocolProblem = (
  target: ResolvedTarget,
  deployed: { imageProtocol: string | null } | null,
): CompatibilityProblem | null => {
  const wanted = target.compute.imageProtocol;
  if (!target.compute.enabled || wanted === null) {
    return null;
  }

  if (wanted !== PROCESSOR_PROTOCOL_ID) {
    return {
      reason:
        `The configured ${target.environment} image protocol is "${wanted}", but ` +
        `this source speaks "${PROCESSOR_PROTOCOL_ID}".`,
      remedy:
        'The processor protocol is frozen: changing it changes the wire format of /encode and\n' +
        '  every running instance. Either deploy an image built from this source, or configure\n' +
        '  the protocol this source actually implements:\n' +
        `    bun run deploy:configure -- --env ${target.environment} --image-protocol ${PROCESSOR_PROTOCOL_ID}`,
    };
  }

  if (deployed === null) {
    return null;
  }

  if (deployed.imageProtocol === null) {
    // Reported rather than assumed compatible. An older release that predates the
    // recorded protocol is the one case where "the image was built from this repo"
    // is an assumption rather than a fact, and it is the assumption that lets a
    // protocol change reach production unnoticed.
    return {
      reason:
        `The last ${target.environment} release recorded no image protocol, so this deploy ` +
        `cannot prove the running image speaks "${PROCESSOR_PROTOCOL_ID}".`,
      remedy:
        'Deploy once with `--jobs-profile encode` so the release records its image identity,\n' +
        '  then re-apply. Until then the running image is treated as incompatible.',
    };
  }

  if (deployed.imageProtocol !== PROCESSOR_PROTOCOL_ID) {
    return {
      reason:
        `The running ${target.environment} image speaks protocol "${deployed.imageProtocol}" and ` +
        `this source speaks "${PROCESSOR_PROTOCOL_ID}".`,
      remedy:
        'Deploying the new web Worker while the old protocol runs would start encodes against an\n' +
        '  image that rejects them, inside jobs accepted before this deploy began.\n' +
        `  Deploy the jobs Worker and its image first:\n` +
        `    bun run deploy apply --env ${target.environment} --yes --only jobs\n` +
        '  A rollback of the web Worker does not roll the image back; see docs/deployment.md.',
    };
  }

  return null;
};

/**
 * The image digests a supported rollback can still return to.
 *
 * Derived from the release history rather than a provider query, so `plan` can
 * print it offline. The newest is the current release; the rest are retained
 * deliberately, and the oldest is the point at which a rollback is no longer
 * something this template supports.
 */
export const rollbackImagePlan = (
  releases: readonly { sourceSha: string; imageDigest: string | null; recordedAt: string }[],
): {
  current: string | null;
  rollbackTo: string[];
  /** False once the history is longer than what is retained. */
  supported: boolean;
} => {
  const withImages = releases.filter((release) => release.imageDigest !== null);
  const current = withImages[0]?.imageDigest ?? null;
  const rollbackTo = withImages
    .slice(1, 1 + RETAINED_PREVIOUS_IMAGES)
    .map((release) => release.imageDigest as string);

  // "Supported" is a statement about the *history*, not about this deploy: once
  // more images exist than are retained, the oldest rollback target is gone and the
  // procedure in docs/deployment.md can no longer promise it.
  return {
    current,
    rollbackTo,
    supported: withImages.length <= RETAINED_IMAGE_REVISIONS,
  };
};

/**
 * Whether a Workflow instance may still be running against a release.
 *
 * The honest answer is always "possibly", and the module says so rather than
 * pretending the provider can be asked. What it *can* do is refuse the operation
 * that would make a running instance's answer ambiguous — deploying a
 * protocol-incompatible image over a live one — and record the fact.
 */
export const workflowSerializationNote = (): string =>
  "Workflow instance serialisation is guaranteed within one repository's deployment path: " +
  'the apply job holds a concurrency group per environment, so two applies to one ' +
  'environment cannot overlap. It is NOT a provider-wide lock. A `wrangler deploy` run from ' +
  'an operator laptop, another repository pointed at the same account, or a second account ' +
  'holder deploying by hand all bypass it. Treat the recorded release history as the only ' +
  'truth about what is deployed, and read docs/deployment.md before deploying by hand.';
