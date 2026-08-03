import {
  QUALITY_REVIEW_ADVICE_SCHEMA,
  QUALITY_REVIEW_REPORT_SCHEMA,
  QUALITY_REVIEW_RUBRIC_SCHEMA,
  QualityReviewAdviceSchema,
  QualityReviewReportSchema,
  QualityReviewRubricSchema
} from './quality-review-protocol.mjs';
import { parseProtocol } from './protocol-validation.mjs';

export const parseQualityReviewRubric = (value) =>
  parseProtocol(QualityReviewRubricSchema, value, QUALITY_REVIEW_RUBRIC_SCHEMA);
export const parseQualityReviewAdvice = (value) =>
  parseProtocol(QualityReviewAdviceSchema, value, QUALITY_REVIEW_ADVICE_SCHEMA);
export const parseQualityReviewReport = (value) =>
  parseProtocol(QualityReviewReportSchema, value, QUALITY_REVIEW_REPORT_SCHEMA);
