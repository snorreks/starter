// apps/e2e/visual.ts
//
// Screenshot capture for visual review.
//
// Two rules this file follows, both learned from projects that got them wrong:
//
//   1. **A skipped visual check reports as skipped.** Not "passed". A suite that
//      prints green because the vision step was unavailable is worse than one
//      that prints "skipped: no API key", because green means nothing here.
//
//   2. **Nothing is uploaded and nothing is sent anywhere without being asked.**
//      Screenshots can contain unreleased UI and whatever the fixture happens to
//      show. They are written to a local directory and left there.
//
// The `inspect` step needs a model that can see images. When none is configured,
// capture still runs and the inspection step records why it did not happen.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceDir } from './preflight.ts';

export type EvidenceResult = {
  /** Files written, relative to the evidence directory. */
  captured: string[];
  /** Absolute directory they were written to. */
  directory: string;
  /** Set when no vision model was available. Absent means it did run. */
  inspectionSkipped?: string;
  inspectionFindings?: VisionFinding[];
};

export type VisionFinding = {
  fixture: string;
  /** What the model was asked to judge. */
  question: string;
  verdict: 'ok' | 'suspicious';
  note: string;
};

export const ensureEvidenceDir = (): string => {
  const directory = evidenceDir();
  mkdirSync(directory, { recursive: true });
  return directory;
};

export const evidencePath = (name: string): string => join(ensureEvidenceDir(), name);

/**
 * Whether a vision model is configured.
 *
 * Reads a key from the environment and nothing else: no import of a provider SDK,
 * no network probe. The purpose is to decide whether to *report a skip*, and a
 * probe that fails for an unrelated reason must not look like an answer.
 */
export const visionConfigured = (): { available: boolean; reason?: string } => {
  const key = process.env.VISION_API_KEY ?? process.env.OPENAI_API_KEY;
  if (key === undefined || key.trim().length === 0) {
    return {
      available: false,
      reason: 'no VISION_API_KEY or OPENAI_API_KEY in the environment',
    };
  }
  if (process.env.VISION_DISABLE === '1') {
    return { available: false, reason: 'VISION_DISABLE=1 was set explicitly' };
  }
  return { available: true };
};

/**
 * The result to report when no vision model is available.
 *
 * Written out rather than thrown so the caller decides how loudly to say it.
 */
export const inspectionSkippedBecause = (): EvidenceResult => ({
  captured: [],
  directory: ensureEvidenceDir(),
  inspectionSkipped: visionConfigured().reason ?? 'vision inspection is unavailable',
});

/** Print a summary that cannot be mistaken for a pass. */
export const reportEvidence = (result: EvidenceResult): void => {
  process.stdout.write(`\nvisual evidence -> ${result.directory}\n`);

  for (const file of result.captured) {
    process.stdout.write(`  captured: ${file}\n`);
  }

  if (result.inspectionFindings !== undefined) {
    for (const finding of result.inspectionFindings) {
      process.stdout.write(
        `  ${finding.verdict === 'ok' ? 'ok       ' : 'SUSPECT  '} ${finding.fixture}: ${finding.note}\n`,
      );
    }
  }

  if (result.inspectionSkipped !== undefined) {
    // Deliberately not "ok". A skipped check that reads as a pass is the failure
    // mode this whole file is written around.
    process.stdout.write(
      `\n  SKIPPED: visual inspection did not run — ${result.inspectionSkipped}.\n` +
        '          Screenshots were captured and are on disk for a human to review.\n',
    );
  }
};