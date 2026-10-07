import { Value } from 'typebox/value';
import { type Static, Type } from 'typebox';

const DimensionSchema = Type.Union([
  Type.Object(
    {
      score: Type.Integer({ minimum: 0, maximum: 4 }),
      evidence: Type.String({ minLength: 1, maxLength: 600 }),
      uncertainty: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      unassessable: Type.Literal(true),
      evidence: Type.String({ minLength: 1, maxLength: 600 }),
      uncertainty: Type.Union([Type.Literal('medium'), Type.Literal('high')]),
    },
    { additionalProperties: false },
  ),
]);

const DimensionName = Type.Union([
  Type.Literal('layout'),
  Type.Literal('typography'),
  Type.Literal('hierarchy'),
  Type.Literal('consistency'),
  Type.Literal('responsiveFit'),
  Type.Literal('stateClarity'),
]);

const IssueSchema = Type.Object(
  {
    dimension: DimensionName,
    requirementId: Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()]),
    category: Type.String({ minLength: 1, maxLength: 80 }),
    severity: Type.Union([Type.Literal('minor'), Type.Literal('major'), Type.Literal('blocker')]),
    observation: Type.String({ minLength: 1, maxLength: 600 }),
    region: Type.String({ minLength: 1, maxLength: 160 }),
    box: Type.Union([
      Type.Object(
        {
          x: Type.Number({ minimum: 0, maximum: 1 }),
          y: Type.Number({ minimum: 0, maximum: 1 }),
          width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
          height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    impact: Type.String({ minLength: 1, maxLength: 400 }),
    correction: Type.String({ minLength: 1, maxLength: 400 }),
    uncertainty: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  },
  { additionalProperties: false },
);

export const ReviewResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
    dimensions: Type.Object(
      {
        layout: DimensionSchema,
        typography: DimensionSchema,
        hierarchy: DimensionSchema,
        consistency: DimensionSchema,
        responsiveFit: DimensionSchema,
        stateClarity: DimensionSchema,
      },
      { additionalProperties: false },
    ),
    requirements: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 80 }),
          status: Type.Union([Type.Literal('met'), Type.Literal('violated'), Type.Literal('unclear')]),
          evidence: Type.String({ minLength: 1, maxLength: 600 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 40 },
    ),
    issues: Type.Array(IssueSchema, { maxItems: 40 }),
    reference: Type.Union([
      Type.Object(
        {
          score: Type.Integer({ minimum: 0, maximum: 4 }),
          evidence: Type.String({ minLength: 1, maxLength: 600 }),
          allowedDifferences: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export type ReviewResult = Static<typeof ReviewResultSchema>;

export const validateReviewResult = (
  input: unknown,
  requirementIds: readonly string[],
): ReviewResult => {
  if (!Value.Check(ReviewResultSchema, input)) {
    const errors = [...Value.Errors(ReviewResultSchema, input)]
      .slice(0, 8)
      .map((error) => `${'path' in error ? error.path || '/' : '/'}: ${error.message}`)
      .join('\n');
    throw new Error(`Vision result does not match schema v1:\n${errors}`);
  }
  const result = input as ReviewResult;
  const supplied = result.requirements.map((requirement) => requirement.id);
  if (new Set(supplied).size !== supplied.length) throw new Error('Vision result repeats a requirement id.');
  if (supplied.length !== requirementIds.length || requirementIds.some((id) => !supplied.includes(id))) {
    throw new Error('Vision result requirement ids do not exactly match the supplied requirements.');
  }
  const allowed = new Set(requirementIds);
  for (const issue of result.issues) {
    if (issue.requirementId !== null && !allowed.has(issue.requirementId)) {
      throw new Error(`Vision issue refers to unknown requirement ${issue.requirementId}.`);
    }
    if (issue.box !== null && (issue.box.x + issue.box.width > 1 || issue.box.y + issue.box.height > 1)) {
      throw new Error('Vision issue bounding box extends beyond the normalized image.');
    }
  }
  return result;
};

export const reviewJsonSchema = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(ReviewResultSchema)) as Record<string, unknown>;
