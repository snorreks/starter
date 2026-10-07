import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const DimensionSchema = v.union([
  v.strictObject({
    score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)),
    evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
    uncertainty: v.union([v.literal('low'), v.literal('medium'), v.literal('high')]),
  }),
  v.strictObject({
    unassessable: v.literal(true),
    evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
    uncertainty: v.union([v.literal('medium'), v.literal('high')]),
  }),
]);

const DimensionName = v.union([
  v.literal('layout'),
  v.literal('typography'),
  v.literal('hierarchy'),
  v.literal('consistency'),
  v.literal('responsiveFit'),
  v.literal('stateClarity'),
]);

const IssueSchema = v.strictObject({
  dimension: DimensionName,
  requirementId: v.union([v.pipe(v.string(), v.minLength(1), v.maxLength(80)), v.null()]),
  category: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  severity: v.union([v.literal('minor'), v.literal('major'), v.literal('blocker')]),
  observation: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
  region: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  box: v.union([
    v.strictObject({
      x: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      y: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      width: v.pipe(v.number(), v.maxValue(1), v.gtValue(0)),
      height: v.pipe(v.number(), v.maxValue(1), v.gtValue(0)),
    }),
    v.null(),
  ]),
  impact: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
  correction: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
  uncertainty: v.union([v.literal('low'), v.literal('medium'), v.literal('high')]),
});

export const ReviewResultSchema = v.strictObject({
  schemaVersion: v.literal(1),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  dimensions: v.strictObject({
    layout: DimensionSchema,
    typography: DimensionSchema,
    hierarchy: DimensionSchema,
    consistency: DimensionSchema,
    responsiveFit: DimensionSchema,
    stateClarity: DimensionSchema,
  }),
  requirements: v.pipe(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        status: v.union([v.literal('met'), v.literal('violated'), v.literal('unclear')]),
        evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
      }),
    ),
    v.maxLength(40),
  ),
  issues: v.pipe(v.array(IssueSchema), v.maxLength(40)),
  reference: v.union([
    v.strictObject({
      score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)),
      evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
      allowedDifferences: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
        v.maxLength(20),
      ),
    }),
    v.null(),
  ]),
});

export type ReviewResult = v.InferOutput<typeof ReviewResultSchema>;

export const validateReviewResult = (
  input: unknown,
  requirementIds: readonly string[],
): ReviewResult => {
  const parsed = v.safeParse(ReviewResultSchema, input);
  if (!parsed.success) {
    const errors = parsed.issues
      .slice(0, 8)
      .map((issue) => `${issue.path?.map(({ key }) => key).join('.') || '/'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Vision result does not match schema v1:\n${errors}`);
  }
  const result = parsed.output;
  const supplied = result.requirements.map((requirement) => requirement.id);
  if (new Set(supplied).size !== supplied.length) {
    throw new Error('Vision result repeats a requirement id.');
  }
  if (
    supplied.length !== requirementIds.length ||
    requirementIds.some((id) => !supplied.includes(id))
  ) {
    throw new Error(
      'Vision result requirement ids do not exactly match the supplied requirements.',
    );
  }
  const allowed = new Set(requirementIds);
  for (const issue of result.issues) {
    if (issue.requirementId !== null && !allowed.has(issue.requirementId)) {
      throw new Error(`Vision issue refers to unknown requirement ${issue.requirementId}.`);
    }
    if (
      issue.box !== null &&
      (issue.box.x + issue.box.width > 1 || issue.box.y + issue.box.height > 1)
    ) {
      throw new Error('Vision issue bounding box extends beyond the normalized image.');
    }
  }
  return result;
};

export const reviewJsonSchema = (): Record<string, unknown> => {
  const { $schema: _draft, ...schema } = toJsonSchema(ReviewResultSchema);
  return schema;
};
