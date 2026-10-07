import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gradeReview } from '../src/visual/grade.ts';
import {
  type ReviewResult,
  reviewJsonSchema,
  validateReviewResult,
} from '../src/visual/schemas.ts';

const dimension = { score: 3, evidence: 'Text remains readable.', uncertainty: 'low' } as const;
const review: ReviewResult = {
  schemaVersion: 1,
  summary: 'The page meets the declared requirements.',
  dimensions: {
    layout: dimension,
    typography: dimension,
    hierarchy: dimension,
    consistency: dimension,
    responsiveFit: dimension,
    stateClarity: dimension,
  },
  requirements: [{ id: 'primary-action-visible', status: 'met', evidence: 'Button is visible.' }],
  issues: [],
  reference: null,
};

describe('structured visual review', () => {
  test('keeps the provider JSON Schema in sync with its golden contract', () => {
    const golden = JSON.parse(
      readFileSync(new URL('./fixtures/review-result.schema.json', import.meta.url), 'utf8'),
    );
    expect(reviewJsonSchema()).toEqual(golden);
  });

  test('validates exact supplied requirement identifiers', () => {
    expect(validateReviewResult(review, ['primary-action-visible'])).toEqual(review);
    expect(() => validateReviewResult(review, ['primary-action-visible', 'no-overflow'])).toThrow(
      'do not exactly match',
    );
  });

  test('rejects unbounded issue boxes and unknown requirement references', () => {
    const outside = structuredClone(review);
    outside.issues = [
      {
        dimension: 'layout',
        requirementId: null,
        category: 'overflow',
        severity: 'major',
        observation: 'The block extends beyond the image.',
        region: 'body',
        box: { x: 0.8, y: 0.1, width: 0.4, height: 0.2 },
        impact: 'It is clipped.',
        correction: 'Reduce its width.',
        uncertainty: 'low',
      },
    ];
    expect(() => validateReviewResult(outside, ['primary-action-visible'])).toThrow(
      'extends beyond',
    );
  });

  test('blockers fail independently and unassessable dimensions need review', () => {
    const blocked = structuredClone(review);
    blocked.issues = [
      {
        dimension: 'layout',
        requirementId: 'primary-action-visible',
        category: 'missing-action',
        severity: 'blocker',
        observation: 'The action is absent.',
        region: 'main',
        box: null,
        impact: 'The task cannot be completed.',
        correction: 'Restore the action.',
        uncertainty: 'low',
      },
    ];
    expect(gradeReview(blocked, { requirementIds: ['primary-action-visible'] }).status).toBe(
      'failed',
    );
    const uncertain = structuredClone(review);
    uncertain.dimensions.layout = {
      unassessable: true,
      evidence: 'The crop hides the page.',
      uncertainty: 'high',
    };
    expect(gradeReview(uncertain, { requirementIds: ['primary-action-visible'] }).status).toBe(
      'needs-human-review',
    );
  });
});
