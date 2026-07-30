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
