export type ExecutionReason = { code: string; [key: string]: unknown };

export type InputDisposition = {
  version_id?: string;
  document_version_id?: string;
  disposition: 'used' | 'not_used';
  reason: string | null;
};

export type InputContribution = {
  schema_version: 'aiws.input_contribution.v1';
  id: string;
  effect: 'basis' | 'constraint' | 'comparison' | 'verification' | 'contradiction' | 'reference';
  expected_effect: string;
  target_output_keys: string[];
  target_criterion_ids: string[];
  target_criteria?: string[];
  origin: 'declared' | 'system';
};

export type TaskInputEffect = {
  claim_id?: string;
  input_key: string;
  version_ids: string[];
  effect: InputContribution['effect'];
  output_keys: string[];
  contribution_id?: string;
  criterion_ids?: string[];
  verification_status?: 'structurally_verified';
  source_receipts?: string[];
  statement: string;
  evidence_refs: string[];
};

export type TaskContextEffect = Omit<TaskInputEffect, 'input_key' | 'version_ids'> & {
  document_version_id: string;
};

export type EffectClaimStatus = {
  claim_id: string;
  source_type: 'input' | 'context';
  input_key: string | null;
  document_version_id: string | null;
  contribution_id: string | null;
  output_keys: string[];
  criterion_ids: string[];
  status: 'structurally_verified' | 'accepted';
};

export type EffectAcceptanceResult = {
  claim_id: string;
  status: 'accepted';
  source_type: 'input' | 'context';
  input_key: string | null;
  document_version_id: string | null;
  contribution_id: string | null;
  source_receipts: string[];
  output_key: string;
  output_version_id: string | null;
  output_content_sha256: string | null;
  criterion_ids: string[];
  output_evidence_refs: string[];
  attestor_type: 'human' | 'trusted_verifier';
  attestor_id: string | null;
};

export type ContributionStatus = {
  contribution_id: string;
  status: 'structurally_verified' | 'accepted';
  output_keys: string[];
  criterion_ids: string[];
  version_ids: string[];
  claim_ids: string[];
  accepted_claim_ids: string[];
  accepted_criterion_ids: string[];
  missing_criterion_ids: string[];
  source_receipts: string[];
  evidence_refs: string[];
};

export type TaskHandoffRoute = {
  route_type: 'task_input' | 'workstream_input' | 'workstream_boundary';
  producer_task_id?: string;
  output_key?: string;
  consumer_task_id?: string;
  consumer_task_title?: string | null;
  input_key?: string;
  purpose?: string | null;
  application_policy?: 'required' | 'optional';
  target_output_keys?: string[];
  target_criterion_ids?: string[];
  contribution_id?: string;
  contribution_schema_version?: 'aiws.input_contribution.v1';
  effect?: InputContribution['effect'];
  expected_effect?: string;
  route_id?: string;
  route_contract_hash?: string;
  workstream_id?: string | null;
};

export type TaskHandoffDiagnostics = {
  schema_version:
    | 'aiws.task_handoff_diagnostics.v1'
    | 'aiws.task_handoff_diagnostics.v2'
    | 'aiws.task_handoff_diagnostics.v3'
    | 'aiws.task_handoff_diagnostics.v4';
  handoff_status: 'awaiting_execution' | 'incomplete' | 'ready';
  required_inputs: Array<{
    slot_key: string;
    required: boolean;
    consumption_policy: string;
    application_policy?: 'required' | 'optional';
    purpose?: string | null;
    target_output_keys?: string[];
    contribution?: InputContribution | null;
    version_ids: string[];
  }>;
  used_inputs: string[];
  not_used_inputs: InputDisposition[];
  missing_dispositions: string[];
  exported_outputs: Array<{
    output_key: string;
    required: boolean;
    consumer_hint?: string | null;
    asset_id?: string | null;
    version_id?: string | null;
    handoff_manifest_sha256?: string | null;
    route_count?: number;
    effect_count?: number;
    routes?: TaskHandoffRoute[];
  }>;
  input_effect_obligations?: Array<{
    input_key: string;
    source: string;
    required: boolean;
    application_policy: 'required' | 'optional';
    purpose?: string | null;
    target_output_keys: string[];
    coverage_policy: 'all' | 'any';
    version_ids: string[];
    satisfied: boolean;
    accepted?: boolean | null;
    contribution?: InputContribution | null;
  }>;
  input_effects?: TaskInputEffect[];
  context_effects?: TaskContextEffect[];
  contribution_statuses?: ContributionStatus[];
  effect_claim_statuses?: EffectClaimStatus[];
  context_used: string[];
  context_not_used: InputDisposition[];
  semantic_gaps: ExecutionReason[];
};
