export type StepState = {
  ready: boolean;
  status: string;
  detail?: string;
  checks?: Record<string, boolean>;
  profile_id?: string;
  installation_count?: number;
};
export type SetupState = {
  complete: boolean;
  mode: 'hosted' | 'byo' | null;
  can_complete: boolean;
  completed_at?: string | null;
  steps: { github: StepState; codex: StepState };
  reasons: string[];
};

export type DeploymentStatus = {
  mode: 'container' | 'host';
  local_only: boolean;
  collaboration: { mode: 'local' | 'gateway'; mcp_gateway: boolean; public_endpoint_configured: boolean };
  storage: { type: 'docker_volume' | 'local_directory'; ready: boolean };
  docker: { strategy: 'socket' | 'local_cli'; ready: boolean };
  imports: {
    codex_home: boolean;
    cc_switch: boolean;
    projects_root: boolean;
    project_path_mode: 'relative' | 'absolute';
  };
};

export type McpClientRecord = {
  id: string;
  name: string;
  kind: 'external' | 'internal_codex' | string;
  token_prefix: string;
  subject_user_id: string | null;
  scopes: string[];
  project_allowlist: string[];
  expires_at: string | null;
  status: 'active' | 'revoked' | 'expired';
  concurrent_limit: number;
  rate_limit_per_minute: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  usage_count: number;
};
export type McpClientSubject = { id: string; display_name: string; role: string };
export type McpClientList = {
  clients: McpClientRecord[];
  available_scopes: string[];
  available_subjects: McpClientSubject[];
};
export type McpClientConfiguration = {
  streamable_http: { url: string; headers: { Authorization: string } };
  codex_toml: string;
  stdio_json: { command: string; args: string[]; env: { AIWS_MCP_URL: string; AIWS_MCP_TOKEN: string } };
};
export type McpClientCreated = {
  client: McpClientRecord;
  token: string;
  token_visible_once: true;
  configuration: McpClientConfiguration;
};

export type Project = {
  id: string;
  title: string;
  goal: string;
  status: string;
  repo_path?: string;
  workspace_root?: string;
  current_workspace_id: string;
  default_repository_workspace_id?: string | null;
  workflow_count?: number;
  asset_count?: number;
  run_count?: number;
  onboarding_state?: string;
  managed_workspace_state?: string;
  current_user_role?: 'owner' | 'collaborator' | 'viewer' | null;
  workflow_migration_status?: string | null;
  deleted_at?: string | null;
  source_hash?: string | null;
};

export type ProjectIntakeMode = 'brainstorm' | 'existing';
export type ProjectCodeSource = {
  type: 'github' | 'git' | 'local_directory' | 'local_git' | 'archive';
  url?: string;
  repository_url?: string;
  path?: string;
  name?: string;
  path_scope?: 'host_import_root' | 'host_path' | 'managed_upload';
};
export type ProjectContextSource = {
  type: 'url' | 'text' | 'file' | 'image' | 'pdf' | 'docx' | 'xlsx';
  label?: string;
  url?: string;
  text?: string;
  path?: string;
  path_scope?: 'host_import_root' | 'managed_import';
  sha256?: string | null;
};
export type ProjectIntakeAnswers = {
  goal?: string;
  users?: string[];
  target_users?: string[];
  features?: string[];
  scope_in?: string[];
  scope_out?: string[];
  constraints?: string[];
  milestones?: string[];
  acceptance_criteria?: string[];
  risks?: string[];
  open_questions?: string[];
};
export type ProjectIntake = {
  id: string;
  project_id: string;
  mode: ProjectIntakeMode | null;
  status: string;
  code_source?: ProjectCodeSource | null;
  context_sources: ProjectContextSource[];
  answers: ProjectIntakeAnswers;
  revision: number;
  last_error?: string | null;
  updated_at?: string;
};
export type BriefMarkdownSection = {
  id: string;
  semantic_key?: string | null;
  title: string;
  type: 'markdown';
  markdown: string;
};
export type BriefListSection = {
  id: string;
  semantic_key?: string | null;
  title: string;
  type: 'list';
  items: string[];
};
export type BriefKeyValueSection = {
  id: string;
  semantic_key?: string | null;
  title: string;
  type: 'key_value';
  entries: Array<{ id: string; key: string; value: string }>;
};
export type BriefTableSection = {
  id: string;
  semantic_key?: string | null;
  title: string;
  type: 'table';
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ id: string; cells: Record<string, string> }>;
};
export type BriefSection = BriefMarkdownSection | BriefListSection | BriefKeyValueSection | BriefTableSection;
export type ProjectBriefContent = {
  schema_version: 2;
  title: string;
  summary: string;
  sections: BriefSection[];
  template_ref?: { template_id: string; version: number } | null;
  material_references?: Array<{
    id: string;
    attachment_id?: string | null;
    url?: string | null;
    label: string;
    kind: string;
  }>;
  goal: string;
  users: string[];
  scope: { in: string[]; out: string[] };
  features: string[];
  constraints: string[];
  milestones: string[];
  acceptance_criteria: string[];
  risks: string[];
  open_questions: string[];
};
export type ProjectBrief = {
  id: string;
  project_id: string;
  version: number;
  revision: number;
  status: string;
  source: string;
  content: ProjectBriefContent;
  created_at: string;
  updated_at?: string;
};
export type WorkflowDraftNode = {
  id: string;
  type: NodeKind;
  role?: 'workstream' | 'task';
  parent_node_id?: string | null;
  title: string;
  goal: string;
  dependency_ids: string[];
  outcome?: string | null;
  category?: WorkstreamCategory | null;
  task_kind?: TaskKind | null;
  execution_mode?: ExecutionMode | null;
  boundary?: Record<string, unknown> | null;
  acceptance_criteria?: string[];
  required?: boolean;
  capability_tags?: string[];
  input_slots?: NodeInputSlot[];
  output_slots?: NodeOutputSlot[];
  atomic_justification?: string | null;
  position: { x: number; y: number };
  order: number;
  dependency_indexes?: number[];
};
export type WorkflowDraft = {
  id: string;
  project_id: string;
  revision: number;
  nodes: WorkflowDraftNode[];
  source_brief_id?: string | null;
  source_brief_revision?: number | null;
  status?: string;
  user_modified_at?: string | null;
  updated_at?: string;
};
export type BriefTemplate = {
  id: string;
  template_key: string;
  version: number;
  title: string;
  domain: string;
  content: ProjectBriefContent;
  sources: Array<{ url?: string | null; attachment_id?: string | null; label?: string | null }>;
  publisher?: string | null;
  retrieved_at: string;
  applicability?: string | null;
  limitations?: string | null;
  created_at: string;
  updated_at: string;
};
export type ProjectImportJob = {
  id: string;
  project_id: string;
  operation_key: string;
  kind?: string;
  status: string;
  error_code?: string;
  source_hash?: string;
  created_at: string;
  updated_at?: string;
};
export type ProjectOnboarding = {
  project: Project;
  intake: ProjectIntake;
  brief: ProjectBrief | null;
  briefs: ProjectBrief[];
  workflow_draft: WorkflowDraft | null;
  imports: ProjectImportJob[];
  assist_session?: AssistSession | null;
  can_confirm: boolean;
  onboarding_route: string;
};
export type DraftProjectResult = {
  project: Project;
  intake: ProjectIntake;
  brief?: ProjectBrief | null;
  workflow_draft?: WorkflowDraft | null;
  assist_session?: AssistSession;
  onboarding_route?: string;
  idempotent?: boolean;
};
export type Workflow = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  version?: number;
  workflow_revision?: number;
  hierarchy_mode?: 'two_level' | 'legacy';
  legacy_read_only?: boolean;
  semantic_migration_status?: string;
  planning_quality?: 'verified' | 'legacy_unverified' | string;
  project_classification?: string | null;
  brief_coverage?: Record<string, string[]>;
  created_at?: string;
  updated_at?: string;
  graph_json?: { nodes?: unknown[]; edges?: unknown[] };
};
export type ExecutionStatus =
  | 'pending'
  | 'ready'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'awaiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export type ExecutionReason = { code: string; [key: string]: unknown };
export type InputDisposition = {
  version_id?: string;
  document_version_id?: string;
  disposition: 'used' | 'not_used';
  reason: string | null;
};
export type TaskHandoffDiagnostics = {
  schema_version: 'aiws.task_handoff_diagnostics.v1';
  handoff_status: 'awaiting_execution' | 'incomplete' | 'ready';
  required_inputs: Array<{
    slot_key: string;
    required: boolean;
    consumption_policy: string;
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
  }>;
  context_used: string[];
  context_not_used: InputDisposition[];
  semantic_gaps: ExecutionReason[];
};
export type TaskExecutionRecord = {
  id: string;
  workflow_execution_id: string;
  project_id: string;
  workflow_id: string;
  workstream_id: string;
  task_id: string;
  task_revision: number;
  contract_id: string;
  contract_version: number;
  attempt: number;
  executor: string;
  status: ExecutionStatus;
  readiness: { ready: boolean; reasons: ExecutionReason[]; checked_at?: string; handoff?: TaskHandoffDiagnostics };
  input_snapshot_hash?: string | null;
  context_selection_id?: string | null;
  context_selection_ids?: string[];
  consumed_inputs?: string[];
  consumed_context_document_versions?: string[];
  input_dispositions?: InputDisposition[];
  context_dispositions?: InputDisposition[];
  handoff_diagnostics?: TaskHandoffDiagnostics | null;
  context_snapshot?: {
    inputs?: TaskExecutionInput[];
    system_context?: {
      context_selection_id?: string | null;
      document_versions?: TaskContextDocumentVersion[];
    };
    asset_mounts?: unknown[];
    repository_checkout?: Record<string, unknown> | null;
  } | null;
  output_bindings: ExecutionOutputBinding[];
  acceptance_results?: unknown[];
  error_code?: string | null;
  retry_class?: string | null;
  integration?: {
    pull_request_intent_id?: string;
    stage?: string;
    pr_number?: number;
    pr_url?: string;
    merged_sha?: string;
  } | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
};
export type WorkflowExecutionRecord = {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_revision: number;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  frontier: Array<{ task_execution_id: string; task_id: string; status: ExecutionStatus; executor: string }>;
  waiting_reasons: Array<{ task_execution_id: string; task_id: string; reasons: ExecutionReason[] }>;
  started_at: string;
  completed_at?: string | null;
  updated_at: string;
};
export type RepositoryLineRecord = {
  id: string;
  workflow_execution_id: string;
  workstream_id: string;
  connection_id: string;
  base_ref: string;
  base_sha?: string | null;
  branch: string;
  head_sha?: string | null;
  status: string;
  pr_number?: number | null;
  pr_url?: string | null;
  merged_sha?: string | null;
};
export type WorkflowExecutionSnapshot = {
  workflow_execution: WorkflowExecutionRecord;
  task_executions: TaskExecutionRecord[];
  repository_lines: RepositoryLineRecord[];
  frontier: WorkflowExecutionRecord['frontier'];
  waiting_reasons: WorkflowExecutionRecord['waiting_reasons'];
};
export type WorkflowExecutionList = { items: WorkflowExecutionRecord[]; current: WorkflowExecutionSnapshot | null };
export type TaskExecutionInput = {
  key: string;
  kind?: string;
  required?: boolean;
  consumption_policy?: 'must_use' | 'must_acknowledge' | 'available' | null;
  source: string;
  selector?: string | null;
  ref_id?: string | null;
  resolved_from?: {
    kind: 'task_execution_outputs' | 'workstream_outcome' | string;
    workflow_execution_id?: string | null;
    task_id?: string | null;
    task_title?: string | null;
    task_execution_id?: string | null;
    workstream_id?: string | null;
    workstream_title?: string | null;
    outcome_asset_id?: string | null;
    outcome_version_id?: string | null;
    selector?: string | null;
    selected_output_keys?: string[];
    selected_outputs?: Array<{
      output_key?: string | null;
      asset_id: string;
      version_id: string;
      asset_type?: string;
      producer_task_id?: string | null;
      producer_task_title?: string | null;
      producer_task_execution_id?: string | null;
    }>;
  };
  asset_versions?: Array<{
    output_key?: string | null;
    asset_id: string;
    version_id: string;
    asset_type: string;
    content_sha256?: string;
    repository_sha?: string | null;
    title?: string;
    producer_task_id?: string | null;
    producer_task_execution_id?: string | null;
  }>;
};
export type TaskContextDocumentVersion = {
  node_id: string;
  document_version_id: string;
  content_sha256: string;
  source_collection?: string | null;
  source_id?: string | null;
  title?: string | null;
  reason?: string;
  required?: boolean;
  consumption_policy?: 'must_use' | 'must_acknowledge' | 'available' | null;
};
export type ExecutionOutputBinding = {
  key: string;
  asset_id: string;
  version_id: string;
  asset_type: string;
  content_sha256: string;
  repository_sha?: string | null;
  confirmation_policy?: string;
  handoff?: boolean;
  consumer_hint?: string | null;
  handoff_manifest_sha256?: string | null;
  attestation_id?: string;
};
export type PullRequestIntentRecord = {
  id: string;
  status: string;
  revision: number;
  snapshot_hash: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  checks_status: string;
  checks?: Array<{ name: string; status: string; conclusion?: string | null }>;
  approvals: Array<{ action: string; approved_at: string }>;
  pr_number?: number | null;
  pr_url?: string | null;
  merge_commit_sha?: string | null;
};
export type TaskExecutionOutput = ExecutionOutputBinding & {
  asset?: AssetRecord;
  version?: AssetVersionRecord;
  attestation?: AssetAttestationRecord;
  bound?: boolean;
};
export type TaskExecutionDetails = {
  task_execution: TaskExecutionRecord;
  workflow_execution: WorkflowExecutionRecord;
  task: WorkflowNode;
  contract: NodeContract;
  inputs: TaskExecutionInput[];
  context_documents?: TaskContextDocumentVersion[];
  asset_mounts: unknown[];
  outputs: TaskExecutionOutput[];
  pull_request_intent?: PullRequestIntentRecord | null;
  handoff: TaskHandoffDiagnostics;
};
export type TaskReadiness = {
  task_id: string;
  workflow_execution_id: string | null;
  task_execution_id: string | null;
  status: string;
  attempt: number;
  readiness: { ready: boolean; reasons: ExecutionReason[] };
};
export type ProjectMembership = {
  id?: string;
  project_id: string;
  user_id: string;
  role: 'owner' | 'collaborator' | 'viewer';
  status?: string;
  implicit?: boolean;
};
export type WorkflowMigrationBatchStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'waiting_active_runs'
  | 'completed'
  | 'completed_with_failures'
  | 'cancelled'
  | string;
export type WorkflowMigrationBatch = {
  id: string;
  status: WorkflowMigrationBatchStatus;
  workflow_ids: string[];
  project_ids: string[];
  approved_by_user_id?: string | null;
  approved_at?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  cancelled_at?: string | null;
};
export type WorkflowMigrationJob = {
  id: string;
  batch_id: string;
  project_id: string;
  workflow_id: string;
  status: string;
  attempt?: number;
  active_run_ids?: string[] | null;
  error_code?: string | null;
  error_detail?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type WorkflowMigrationState = {
  batch: WorkflowMigrationBatch | null;
  jobs: WorkflowMigrationJob[];
  legacy_workflow_ids: string[];
};
export type WorkflowNode = {
  id: string;
  workflow_id: string;
  workspace_id?: string;
  type: NodeKind;
  title: string;
  goal: string;
  status: string;
  order_index: number;
  dependencies: Array<{ node_id?: string; node_order?: number; type: string }>;
  position?: { x: number; y: number };
  current_contract_id?: string;
  role?: 'workstream' | 'task';
  parent_node_id?: string | null;
  outcome?: string | null;
  category?: WorkstreamCategory | null;
  task_kind?: TaskKind | null;
  execution_mode?: ExecutionMode | null;
  boundary?: Record<string, unknown> | null;
  acceptance_criteria?: string[];
  required?: boolean;
  plan_revision?: number | null;
  capability_tags?: string[];
  input_slots?: NodeInputSlot[];
  output_slots?: NodeOutputSlot[];
  atomic_justification?: string | null;
  repository_target_ids?: string[];
  repository_intent?: Record<string, unknown> | null;
  task_count?: number;
  completed_task_count?: number;
  progress?: number;
  blocked_count?: number;
  repository_status?: { target_count: number; ready_count: number } | null;
  latest_run?: {
    id: string;
    status: string;
    summary?: string;
    result_json?: { warnings?: string[]; next_actions?: string[] };
    completed_at?: string;
  };
  output_count?: number;
  pending_approval_count?: number;
  current_task_execution_id?: string | null;
  current_attempt?: number;
  waiting_reasons?: ExecutionReason[];
  execution_evidence_status?: 'managed' | 'external_unverified' | string;
};
export type NodeKind =
  'goal_definition' | 'research' | 'analysis' | 'execution' | 'retrospective' | 'workstream' | 'task';
export type WorkstreamCategory = 'deliverable' | 'decision' | 'coordination' | 'operation';
export type TaskKind =
  'research' | 'analysis' | 'design' | 'content' | 'code' | 'test' | 'review' | 'deploy' | 'manual' | 'integration';
export type ExecutionMode = 'manual' | 'assist' | 'codex' | 'integration';
export type AssistScopeType = 'project' | 'workflow' | 'workstream' | 'task';
export type NodeInputSlot = {
  key: string;
  kind: string;
  required: boolean;
  source: string;
  selector: string | null;
  ref_id: string | null;
  version_id: string | null;
  consumption_policy?: 'must_use' | 'must_acknowledge' | 'available' | null;
};
export type NodeOutputSlot = {
  key: string;
  kind: string;
  required: boolean;
  asset_type: string;
  acceptance_criteria: string[];
  confirmation_policy: 'human' | 'system_evidence';
  handoff?: boolean;
  consumer_hint?: string | null;
  purpose?: string | null;
};
export type NodeContract = {
  id: string;
  node_id: string;
  version: number;
  contract_schema_version?: 2;
  node_goal: string;
  acceptance_criteria: string[];
  allowed_tools: string[];
  expected_inputs: NodeInputSlot[];
  expected_outputs: NodeOutputSlot[];
};
export type ProjectBundle = {
  project: Project;
  workflows: Workflow[];
  nodes: WorkflowNode[];
  contracts: NodeContract[];
  assets: AssetRecord[];
  runs: RunRecord[];
  asset_versions?: AssetVersionRecord[];
  asset_relations?: AssetRelationRecord[];
  submissions?: SubmissionRecord[];
  membership?: ProjectMembership | null;
};
export type AssetRecord = {
  id: string;
  title: string;
  summary?: string;
  type?: string;
  asset_type?: string;
  status: string;
  updated_at: string;
  project_id: string;
  node_id?: string | null;
  task_execution_id?: string | null;
  current_version_id?: string | null;
  output_key?: string | null;
  confirmation_policy?: string | null;
  current_version?: AssetVersionSummary | null;
  attestation_count?: number;
  consumer_count?: number;
};
export type AssetVersionSummary = {
  id: string;
  version: number;
  payload_kind?: string;
  media_type?: string;
  content_sha256?: string;
  size_bytes?: number;
  repository_sha?: string | null;
  verification_status?: string;
};
export type AssetManifestEntry = { path: string; sha256: string; size_bytes: number; media_type: string; role: string };
export type AssetVersionRecord = {
  id: string;
  asset_id: string;
  version?: number;
  title?: string;
  summary?: string;
  output_key?: string | null;
  input_snapshot_hash?: string | null;
  evidence_refs?: string[];
  payload_kind?: string;
  media_type?: string;
  content_sha256?: string;
  size_bytes?: number;
  repository_sha?: string | null;
  verification_status?: string;
  immutable?: boolean;
  manifest?: { entries?: AssetManifestEntry[]; metadata?: Record<string, unknown> };
  provenance?: Record<string, unknown>;
};
export type AssetAttestationRecord = {
  id: string;
  asset_id: string;
  asset_version_id: string;
  decision: string;
  confirmation_policy: string;
  attestor_type: string;
  attestor_id: string;
  expected_sha256: string;
  acceptance_results?: unknown[];
  evidence?: Record<string, unknown>;
  summary?: string;
  created_at: string;
};
export type AssetDetails = {
  asset: AssetRecord;
  versions: AssetVersionRecord[];
  current: AssetVersionRecord | null;
  attestations: AssetAttestationRecord[];
  consumers: AssetConsumer[];
};
export type AssetConsumer = {
  type: string;
  id: string;
  workflow_execution_id?: string;
  task_id?: string;
  status?: string;
  consumption_status?: 'consumed' | 'prepared' | 'evidenced' | string;
  input_keys?: string[];
};
export type AssetVersionDetails = {
  asset: AssetRecord;
  version: AssetVersionRecord;
  attestations: AssetAttestationRecord[];
  lineage: { upstream: AssetRelationRecord[]; downstream: AssetRelationRecord[] };
  consumers: AssetConsumer[];
};
export type AssetRelationRecord = {
  id: string;
  relation_type: string;
  source_asset_id: string;
  source_asset_version_id: string;
  target_asset_id: string;
  target_asset_version_id: string;
  input_snapshot_hash?: string | null;
  execution_id?: string | null;
};
export type SubmissionRecord = {
  id: string;
  node_id?: string | null;
  status: string;
  output_bindings?: Array<{ key: string; asset_id: string; version_id: string }>;
  input_snapshot_hash?: string | null;
};
export type RunRecord = {
  id: string;
  node_id: string;
  status: string;
  summary: string;
  created_at: string;
  repository_workspace_id?: string | null;
  input_snapshot_hash?: string | null;
  repository_snapshot_hash?: string | null;
  input_superseded?: boolean;
};
export type CodeChangeRecord = {
  id: string;
  run_id: string;
  status: string;
  work_branch?: string;
  head_commit?: string;
  pr_url?: string;
};
export type TraceRecord = {
  id: string;
  event_type: string;
  summary: string;
  created_at?: string;
  occurred_at?: string;
  node_id?: string;
};
export type ChangeProposal = {
  id: string;
  project_id: string;
  node_id?: string;
  title: string;
  summary: string;
  change_type: string;
  status: string;
  before_json?: unknown;
  after_json?: unknown;
  risks?: string[];
  impact?: string[];
  evidence_refs?: string[];
  created_at: string;
  attention_state?: 'interrupting' | 'queued' | 'resolved';
  revision?: number;
  target_hash?: string;
  workflow_id?: string;
  workflow_revision?: number;
  destructive?: boolean;
  operations_json?: unknown[];
  apply_action?: Record<string, unknown>;
};
export type ApprovalItemType = 'change_proposal' | 'runtime_approval';
export type ApprovalItem = {
  id: string;
  type: ApprovalItemType;
  project_id?: string;
  node_id?: string;
  title: string;
  summary: string;
  status: string;
  attention_state: 'interrupting' | 'queued' | 'resolved';
  revision: number;
  target_hash: string;
  created_at: string;
  change_type?: string;
  approval_type?: string;
  before_json?: unknown;
  after_json?: unknown;
  risks?: string[];
  impact?: string[];
  evidence_refs?: string[];
};
export type ApprovalDecision = 'approve_apply' | 'reject' | 'defer';
export type ApprovalDecisionResult = {
  item: ApprovalItem;
  applied?: Record<string, unknown>;
  proposal?: ChangeProposal;
};
export type AssistEvent = { id: number; type: string; data: Record<string, unknown>; created_at: string };
export type AssistMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  created_at: string;
};
export type AssistSession = {
  id: string;
  scope_type: string;
  scope_id: string;
  parent_session_id?: string;
  status: string;
  agent_session_id?: string;
  last_event_id?: number;
  messages?: AssistMessage[];
  actions?: UiAction[];
};
export type UiAction = {
  id: string;
  name: string;
  label: string;
  status: string;
  risk: 'reversible' | 'confirm' | 'proposal';
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  turn_id?: string;
  session_id?: string;
};
export type FileEntry = { name: string; path: string; type: 'file' | 'directory'; size?: number };
export type RepositoryConnection = {
  id: string;
  project_id: string;
  full_name?: string;
  default_branch?: string;
  remote_name?: string;
  sync_status?: string;
  permissions?: { read?: boolean; push?: boolean; pull_requests?: boolean };
};
export type RepositoryBranch = { name: string; ref: string; sha: string; source: 'local' | 'remote'; full_ref: string };
export type RepositoryBranchCatalog = {
  project_id: string;
  connection_id: string | null;
  default_branch: string;
  branches: RepositoryBranch[];
};
export type PullRequestSummary = { intent_id: string; number: number | null; url: string | null; state: string };
export type RepositoryWorkspace = {
  id: string;
  project_id: string;
  connection_id: string | null;
  ref: string;
  fixed_sha: string;
  current_sha: string;
  mode: 'read_only' | 'read_write';
  scope: { type: string; id: string | null; path_prefixes: string[] };
  sync_status: 'ready' | 'stale' | string;
  stale: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  status: string;
  revision: number;
  last_synced_at?: string | null;
  pull_requests?: PullRequestSummary[];
  snapshot_hash?: string;
};
export type NodeWorkspace = {
  project: Project;
  workflow: Workflow;
  node: WorkflowNode;
  contract: NodeContract;
  workspace: { id: string; title: string; open_questions: string[] };
  data: Record<string, unknown>;
  runs: RunRecord[];
  code_changes: CodeChangeRecord[];
  assets: AssetRecord[];
  traces: TraceRecord[];
  asset_versions?: AssetVersionRecord[];
  asset_relations?: AssetRelationRecord[];
  submissions?: SubmissionRecord[];
};

export type * from './context-types';
export type * from './assist-types';
export type * from './codex-types';
