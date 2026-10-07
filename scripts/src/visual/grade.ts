import type { ReviewResult } from './schemas.ts';

export interface ReviewGrade {
  score: number | null;
  status: 'passed' | 'failed' | 'needs-human-review';
  reasons: string[];
}

/** Deterministic policy over validated evidence; never trusts provider verdicts. */
export const gradeReview = (
  review: ReviewResult,
  options: { requirementIds: readonly string[]; mandatoryRequirementIds?: readonly string[] },
): ReviewGrade => {
  const allowed = new Set(options.requirementIds);
  const mandatory = new Set(options.mandatoryRequirementIds ?? options.requirementIds);
  for (const id of mandatory) {
    if (!allowed.has(id)) throw new Error(`Unknown mandatory requirement ${id}.`);
  }
  const scoreValues: number[] = [];
  const reasons: string[] = [];
  for (const [name, dimension] of Object.entries(review.dimensions)) {
    if ('unassessable' in dimension) {
      reasons.push(`${name} is unassessable.`);
    } else {
      scoreValues.push(dimension.score);
    }
  }
  const score = scoreValues.length === 0 ? null : Math.round((scoreValues.reduce((a, b) => a + b, 0) / (scoreValues.length * 4)) * 100);
  const requirementById = new Map(review.requirements.map((requirement) => [requirement.id, requirement]));
  let failed = review.issues.some((issue) => issue.severity === 'blocker');
  for (const id of mandatory) {
    const status = requirementById.get(id)?.status;
    if (status === 'violated') {
      failed = true;
      reasons.push(`Mandatory requirement ${id} was reported violated.`);
    } else if (status === 'unclear') {
      reasons.push(`Mandatory requirement ${id} needs human review.`);
    }
  }
  if (review.reference === null && options.requirementIds.includes('reference-fidelity')) {
    throw new Error('Reference fidelity was required but no reference result was supplied.');
  }
  if (failed) return { score, status: 'failed', reasons };
  if (reasons.length > 0) return { score, status: 'needs-human-review', reasons };
  return { score, status: 'passed', reasons: [] };
};
