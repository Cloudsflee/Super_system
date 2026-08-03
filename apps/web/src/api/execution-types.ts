export type WorkflowCompletionStatus =
  'pending' | 'completed' | 'completed_with_gaps' | 'waived' | 'failed' | 'legacy_unassessed';

export type OutcomeSummary = {
  total: number;
  satisfied: number;
  unsatisfied: number;
  waived: number;
  pending: number;
  error: number;
  mandatory_gaps: number;
  optional_gaps: number;
};

export type ExecutionStage = 'preflight' | 'execute' | 'collect' | 'verify' | 'attest' | 'promote' | 'finalize';

export type FailureEnvelope = {
  schema_version: 'aiws.failure_envelope.v1' | string;
  code: string;
  stage: ExecutionStage;
  category: string;
  retryable: boolean;
  message: string | null;
  field_path: string | null;
  details: Record<string, unknown>;
  cause_codes: string[];
  occurred_at: string;
};

export type ExecutionStageCheckpoint = {
  schema_version: 'aiws.execution_checkpoint.v1' | string;
  id: string;
  workflow_execution_id: string;
  task_execution_id: string | null;
  stage: ExecutionStage;
  sequence: number;
  attempt: number;
  status: 'completed' | 'failed';
  input_hash: string;
  output_hash: string | null;
  identity: {
    input_snapshot_hash: string | null;
    repository_sha: string | null;
    runner_image_digest: string | null;
    policy_hash: string;
    verifier_version: string;
    cas_hash: string | null;
  };
  cas_refs: Array<{ sha256: string; size_bytes: number; media_type: string }>;
  duration_ms: number;
  queue_ms: number;
  failure: FailureEnvelope | null;
  replay_of_checkpoint_id: string | null;
  started_at: string;
  completed_at: string;
};

export type TaskStageSnapshot = {
  task_execution_id: string;
  current_stage: ExecutionStage | null;
  replay_count: number;
  failure: FailureEnvelope | null;
  stages: ExecutionStageCheckpoint[];
};

export type OutcomeRequirement = {
  id: string;
  workflow_execution_id: string;
  contract_requirement_id: string;
  source: 'outcome_contract' | 'quality_rubric' | string;
  title: string;
  description: string | null;
  mandatory: boolean;
  scope: string;
  task_id: string | null;
  order: number;
  evaluator: string;
  expected: unknown;
  waivable: boolean;
  contract_hash: string;
};

export type OutcomeEvaluation = {
  id: string;
  requirement_id: string;
  status: 'pending' | 'satisfied' | 'unsatisfied' | 'waived' | 'error';
  expected: unknown;
  actual: unknown;
  evidence_refs: string[];
  reason_code: string;
  evaluator: string;
  evaluator_version: string;
  waiver_id: string | null;
  evaluated_at: string;
};

export type OutcomeWaiver = {
  id: string;
  workflow_execution_id: string;
  action: 'grant';
  requirement_ids: string[];
  reason: string;
  evidence_refs: string[];
  expires_at: string;
  created_by_user_id: string;
  created_at: string;
  active: boolean;
  revoked: boolean;
  expired: boolean;
};

export type WorkflowOutcomeSnapshot = {
  workflow_execution: {
    id: string;
    completion_status?: WorkflowCompletionStatus;
    release_eligible?: boolean;
    outcome_summary?: OutcomeSummary;
    [key: string]: unknown;
  };
  requirements: OutcomeRequirement[];
  evaluations: OutcomeEvaluation[];
  waivers: OutcomeWaiver[];
};

export type QualityReviewDimension = {
  id: string;
  title: string;
  weight: number;
  enabled: boolean;
  instructions?: string;
};

export type QualityReviewRubric = {
  schema_version?: string;
  version: number;
  enabled: boolean;
  mandatory: boolean;
  threshold: number;
  dimensions: QualityReviewDimension[];
};

export type QualityReviewPolicy = {
  enabled: boolean;
  mandatory: boolean;
  strategy: string;
  rubric: QualityReviewRubric | null;
  rubric_hash: string | null;
};

export type WorkflowQualityReviewFields = {
  quality_review_profile_id?: string | null;
  quality_review_policy?: QualityReviewPolicy;
};

export type QualityReviewAsset = {
  asset_id: string;
  asset_version_id: string;
  title: string;
  asset_type?: string;
  output_key?: string | null;
  media_type?: string | null;
  size_bytes: number;
  content_sha256: string;
  required: boolean;
  verification_status?: string;
  immutable?: boolean;
  status?: string;
  task_execution_id?: string | null;
};

export type QualityReviewEvent = {
  id: string;
  run_id: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
};

export type QualityReviewAdvice = {
  schema_version?: string;
  reviewer: { profile_id: string | null; provider: string | null; model: string | null; attempt: number };
  status: 'completed' | 'unavailable' | 'invalid' | string;
  dimensions: Array<{
    criterion_id: string;
    recommendation: number | null;
    rationale: string;
    evidence_anchors: Array<{ anchor_id: string; asset_version_id: string; path: string; locator: string }>;
    limitations?: string[];
  }>;
  limitations: string[];
  generated_at: string;
};

export type QualityReviewReport = {
  id: string;
  run_id: string;
  input_snapshot_hash: string;
  rubric_hash: string;
  deterministic_checks: Array<{ id: string; status: string; message: string; details?: Record<string, unknown> }>;
  assets: Array<QualityReviewAsset & { normalized_text_length: number; anchors: unknown[]; image_count: number }>;
  advice: QualityReviewAdvice;
  limitations: string[];
  generated_at: string;
};

export type QualityReviewRun = {
  id: string;
  workflow_execution_id: string;
  project_id: string;
  status:
    | 'queued'
    | 'preparing'
    | 'checking'
    | 'reviewing'
    | 'awaiting_human'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | string;
  phase: string;
  input_snapshot_hash: string;
  asset_version_ids: string[];
  excluded_assets: Array<{ asset_version_id: string; reason: string }>;
  rubric: QualityReviewRubric;
  rubric_hash: string;
  threshold: number;
  report_id?: string | null;
  report_sha256?: string | null;
  decision?: 'pass' | 'changes_required' | null;
  score?: number | null;
  stale?: boolean;
  error_code?: string | null;
  retryable?: boolean;
  report?: QualityReviewReport | null;
  decision_record?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type QualityReviewPrepare = {
  workflow_execution_id: string;
  enabled: boolean;
  mandatory: boolean;
  default_rubric: QualityReviewRubric;
  threshold: number;
  rubric_hash: string;
  assets: QualityReviewAsset[];
  out_of_scope_assets: QualityReviewAsset[];
  default_included_asset_version_ids: string[];
  reviewer_readiness: QualityReviewerReadiness;
  current_run: QualityReviewRun | null;
  limits: Record<string, number>;
};

export type QualityReviewerCheck = {
  status: 'passed' | 'failed' | 'not_checked' | string;
  ready: boolean;
  code: string | null;
  checked_at: string;
  details: Record<string, unknown>;
};

export type QualityReviewerReadiness = {
  status: 'ready' | 'unavailable' | string;
  ready: boolean;
  advice_available: boolean;
  checked_at: string;
  profile: Record<string, unknown> | null;
  checks: Record<'profile' | 'image' | 'credential' | 'probe' | 'vision', QualityReviewerCheck>;
};

export type QualityReviewHistory = {
  workflow_execution_id: string;
  active: QualityReviewRun | null;
  current: QualityReviewRun | null;
  latest: QualityReviewRun | null;
  items: QualityReviewRun[];
};

export type QualityReviewSnapshot = {
  run: QualityReviewRun;
  report: QualityReviewReport | null;
  decision: Record<string, unknown> | null;
  events: QualityReviewEvent[];
};
