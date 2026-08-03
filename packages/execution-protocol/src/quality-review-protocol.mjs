import { z } from 'zod';

export const QUALITY_REVIEW_RUBRIC_SCHEMA = 'aiws.quality_review_rubric.v1';
export const QUALITY_REVIEW_ADVICE_SCHEMA = 'aiws.quality_review_advice.v1';
export const QUALITY_REVIEW_REPORT_SCHEMA = 'aiws.quality_review_report.v1';

const identifier = z.string().trim().min(1).max(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.iso.datetime({ offset: true });
const jsonValue = z.json();

const QualityReviewDimensionSchema = z
  .object({
    id: identifier.regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/i),
    title: z.string().trim().min(1).max(500),
    weight: z.number().finite().min(0).max(100),
    enabled: z.boolean().default(true),
    instructions: z.string().trim().max(4000).default('')
  })
  .strict();

export const QualityReviewRubricSchema = z
  .object({
    schema_version: z.literal(QUALITY_REVIEW_RUBRIC_SCHEMA),
    version: z.number().int().positive(),
    enabled: z.boolean().default(true),
    mandatory: z.boolean().default(true),
    threshold: z.number().finite().min(0).max(100).default(80),
    dimensions: z.array(QualityReviewDimensionSchema).min(1).max(20)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set();
    for (let index = 0; index < value.dimensions.length; index += 1) {
      const dimension = value.dimensions[index];
      if (ids.has(dimension.id))
        context.addIssue({ code: 'custom', path: ['dimensions', index, 'id'], message: 'duplicate_dimension_id' });
      ids.add(dimension.id);
    }
    const enabledWeight = value.dimensions
      .filter((dimension) => dimension.enabled)
      .reduce((sum, dimension) => sum + dimension.weight, 0);
    if (Math.abs(enabledWeight - 100) > 0.0001)
      context.addIssue({ code: 'custom', path: ['dimensions'], message: 'enabled_weights_must_equal_100' });
  });

const QualityReviewEvidenceAnchorSchema = z
  .object({
    anchor_id: identifier,
    asset_version_id: identifier,
    path: z.string().trim().min(1).max(2000),
    locator: z.string().trim().min(1).max(500),
    excerpt_sha256: sha256.nullable().default(null)
  })
  .strict();

const QualityReviewAdviceDimensionSchema = z
  .object({
    criterion_id: identifier,
    recommendation: z.number().finite().min(0).max(100).nullable(),
    rationale: z.string().trim().max(4000),
    evidence_anchors: z.array(QualityReviewEvidenceAnchorSchema).max(100).default([]),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(20).default([])
  })
  .strict();

export const QualityReviewAdviceSchema = z
  .object({
    schema_version: z.literal(QUALITY_REVIEW_ADVICE_SCHEMA),
    reviewer: z
      .object({
        profile_id: identifier.nullable(),
        provider: identifier.nullable(),
        model: identifier.nullable(),
        attempt: z.number().int().positive()
      })
      .strict(),
    status: z.enum(['completed', 'unavailable', 'invalid']),
    dimensions: z.array(QualityReviewAdviceDimensionSchema).max(20),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
    generated_at: isoDate
  })
  .strict();

export const QUALITY_REVIEW_ADVICE_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'reviewer', 'status', 'dimensions', 'limitations', 'generated_at'],
  properties: {
    schema_version: { const: QUALITY_REVIEW_ADVICE_SCHEMA },
    reviewer: {
      type: 'object',
      additionalProperties: false,
      required: ['profile_id', 'provider', 'model', 'attempt'],
      properties: {
        profile_id: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
        provider: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
        model: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
        attempt: { type: 'integer', minimum: 1 }
      }
    },
    status: { enum: ['completed', 'unavailable', 'invalid'] },
    dimensions: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion_id', 'recommendation', 'rationale', 'evidence_anchors', 'limitations'],
        properties: {
          criterion_id: { type: 'string', minLength: 1, maxLength: 200 },
          recommendation: { type: ['number', 'null'], minimum: 0, maximum: 100 },
          rationale: { type: 'string', maxLength: 4000 },
          evidence_anchors: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['anchor_id', 'asset_version_id', 'path', 'locator', 'excerpt_sha256'],
              properties: {
                anchor_id: { type: 'string', minLength: 1, maxLength: 200 },
                asset_version_id: { type: 'string', minLength: 1, maxLength: 200 },
                path: { type: 'string', minLength: 1, maxLength: 2000 },
                locator: { type: 'string', minLength: 1, maxLength: 500 },
                excerpt_sha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }
              }
            }
          },
          limitations: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 1000 }
          }
        }
      }
    },
    limitations: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 1000 }
    },
    generated_at: { type: 'string', format: 'date-time' }
  }
});

const QualityReviewDeterministicCheckSchema = z
  .object({
    id: identifier,
    status: z.enum(['passed', 'warning', 'blocked']),
    message: z.string().trim().max(2000),
    details: z.record(z.string(), jsonValue).default({})
  })
  .strict();

const QualityReviewAssetSummarySchema = z
  .object({
    asset_id: identifier,
    asset_version_id: identifier,
    title: z.string().trim().max(500),
    media_type: z.string().trim().max(300),
    size_bytes: z.number().int().nonnegative(),
    content_sha256: sha256,
    normalized_text_sha256: sha256.nullable(),
    normalized_text_length: z.number().int().nonnegative(),
    image_count: z.number().int().nonnegative(),
    anchors: z.array(QualityReviewEvidenceAnchorSchema).max(500).default([]),
    status: z.enum(['included', 'out_of_scope', 'failed'])
  })
  .strict();

export const QualityReviewReportSchema = z
  .object({
    schema_version: z.literal(QUALITY_REVIEW_REPORT_SCHEMA),
    id: identifier,
    run_id: identifier,
    workflow_execution_id: identifier,
    project_id: identifier,
    input_snapshot_hash: sha256,
    rubric_hash: sha256,
    deterministic_checks: z.array(QualityReviewDeterministicCheckSchema).max(200),
    assets: z.array(QualityReviewAssetSummarySchema).max(16),
    advice: QualityReviewAdviceSchema,
    limitations: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
    generated_at: isoDate,
    immutable: z.literal(true)
  })
  .strict();
