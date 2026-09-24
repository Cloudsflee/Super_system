export type CapabilityStatus = 'unknown' | 'available' | 'unavailable';
export type ModelSuggestionStatus = 'available' | 'unavailable' | 'invalid';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'archived' | 'trashed' | 'purged';
  onboarding_state?: 'draft' | 'running' | 'ready' | 'failed' | 'cancelled' | 'confirmed';
  current_brief_revision?: number;
  confirmed_brief_revision?: number | null;
  confirmed_brief_hash?: string;
  current_workflow_revision?: number;
  revision: number;
  updated_at: string;
  brief?: Brief | null;
  brief_head?: { revision: number; confirmed_revision?: number | null; confirmation_revision?: number; confirmed_hash?: string; confirmed_at?: string | null; confirmed_by?: string | null } | null;
  intake?: ProjectIntake | null;
  workflow_draft?: WorkflowDraft | null;
  workflow?: Workflow | null;
  repository?: RepositoryBinding | null;
  repository_connections?: RepositoryConnection[];
  repository_lines?: RepositoryLine[];
}

export interface ProjectIntake {
  id: string;
  project_id: string;
  status: 'draft' | 'running' | 'ready' | 'failed' | 'cancelled';
  mode: 'brainstorm' | 'existing';
  revision: number;
  attempt: number;
  operation_id?: string | null;
  source?: { kind: string; display_label?: string; revision?: string; hash?: string; read_only?: boolean };
  result?: Record<string, unknown>;
  error_code?: string;
  completed_at?: string | null;
  cancelled_at?: string | null;
}

export interface WorkflowDraft {
  id: string;
  project_id: string;
  revision: number;
  source_brief_revision: number;
  source_brief_hash?: string;
  status: string;
  hierarchy_mode?: 'two_level';
  generation_status?: string;
  critic_status?: string;
  last_generation_id?: string | null;
  applied_workflow_revision?: number;
  layout_revision?: number;
  draft_hash?: string;
  graph?: WorkflowCandidate | Record<string, never>;
}

export interface Brief {
  project_id: string;
  revision: number;
  content_hash: string;
  content: { objective?: string; constraints?: string[]; acceptance?: string[] };
  created_at: string;
}

export interface RepositoryBinding {
  id: string;
  local_path: string;
  remote_url: string;
  head_sha: string;
  revision: number;
  status?: string;
  baseline_sha?: string;
  connection_id?: string | null;
  target_id?: string | null;
  line_id?: string | null;
  source?: { kind: string; display_label?: string; revision?: string; hash?: string; read_only?: boolean } | null;
  fault_code?: string;
  fault?: Record<string, unknown>;
}

export interface RepositoryConnection {
  id: string;
  project_id: string;
  provider?: string;
  status: string;
  revision: number;
  source_kind?: string;
  display_label?: string;
  source_revision?: string;
  source_hash?: string;
  read_only?: boolean;
  fault_code?: string;
  fault?: Record<string, unknown>;
}

export interface RepositoryLine {
  id: string;
  project_id: string;
  target_id?: string | null;
  line_kind: 'external_readonly' | 'managed_staging' | 'managed_checkout';
  branch?: string;
  head_sha?: string;
  baseline_sha?: string;
  status: string;
  revision: number;
  source_revision?: string;
  source_hash?: string;
  probe_status?: string;
  probe?: Record<string, unknown>;
  fault_code?: string;
  fault?: Record<string, unknown>;
  locked?: boolean;
  last_manifest_hash?: string;
}

export interface WorkflowTask {
  id: string;
  title: string;
  level: 1 | 2;
  deps: string[];
  mode: 'read' | 'write';
  inputs: string[];
  outputs: string[];
  goal?: string;
  workstream_id?: string;
  allowed_tools?: string[];
  acceptance?: string[];
  input_slots?: WorkflowSlot[];
  output_slots?: WorkflowSlot[];
}

export interface WorkflowSlot {
  name: string;
  type: string;
  required: boolean;
  selector: string;
  target_output?: string;
  acceptance: string[];
}

export interface WorkflowWorkstream {
  id: string;
  title: string;
  goal?: string;
  deps: string[];
  tasks: WorkflowTask[];
  acceptance?: string[];
}

export interface WorkflowCandidate {
  hierarchy_mode: 'two_level';
  name: string;
  workstreams: WorkflowWorkstream[];
  tasks: WorkflowTask[];
  hash?: string;
}

export interface WorkflowLayoutRevision {
  id: string;
  draft_id: string;
  draft_revision: number;
  revision: number;
  nodes: Array<{ id: string; position: { x: number; y: number }; width?: number | null; height?: number | null }>;
  viewport: { x?: number; y?: number; zoom?: number };
  layout_hash: string;
  source: string;
  created_at: string;
}

export interface WorkflowCriticReceipt {
  id: string;
  status: 'passed' | 'rejected' | 'failed';
  issues: Array<{ code: string; node_id?: string; field_path?: string }>;
  node_ids: string[];
  field_paths: string[];
  candidate_hash: string;
}

export interface WorkflowProposal {
  id: string;
  status: 'pending' | 'applied' | 'rejected' | 'stale';
  mode: 'initial' | 'replan';
  proposal_hash: string;
  applied_workflow_revision: number;
  candidate: WorkflowCandidate;
}

export interface WorkflowGeneration {
  id: string;
  project_id: string;
  operation_id?: string | null;
  mode: 'initial' | 'replan';
  phase: string;
  status: string;
  brief_revision: number;
  brief_hash: string;
  draft_revision: number;
  layout_revision: number;
  attempt: number;
  error_code?: string;
  candidate_hash?: string;
  candidate: WorkflowCandidate | Record<string, never>;
  critic?: WorkflowCriticReceipt | { status?: string; issues?: Array<string | { code: string }> } | null;
  proposal?: WorkflowProposal;
  created_at: string;
  updated_at: string;
}

export interface NodeContract {
  id: string;
  node_id: string;
  workflow_revision: number;
  contract: {
    goal?: string;
    inputs?: Array<string | WorkflowSlot>;
    outputs?: Array<string | WorkflowSlot>;
    dependencies?: string[];
    allowed_tools?: string[];
    acceptance?: string[];
  };
}

export interface Workflow {
  project_id: string;
  revision: number;
  name: string;
  graph_hash: string;
  tasks: WorkflowTask[];
  hierarchy_mode?: 'two_level';
  draft_revision?: number;
  layout_revision?: number;
  created_at: string;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  attempt_no: number;
  status: 'pending' | 'ready' | 'running' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled';
  mode: string;
  error_code: string;
  output: {
    outcome?: 'completed' | 'failed' | 'cancelled';
    summary?: string;
    retryable?: boolean;
    checks?: Array<{ id: string; passed: boolean; exit_code: number | null; stdout_sha256: string | null }>;
    evidence_assets?: Array<{ id: string; cas_hash: string }>;
  };
}

export interface Execution {
  id: string;
  project_id: string;
  workflow_revision: number;
  brief_revision: number;
  brief_hash: string;
  repository_sha: string;
  context_pack_hash: string;
  status: 'queued' | 'running' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  tasks: TaskAttempt[];
  attempts: TaskAttempt[];
  diff?: { files?: string[]; diff_sha256?: string; byte_size?: number; asset_version_id?: string } | null;
  evidence?: Array<{ id: string; asset_version_id: string; target_type: string; target_id: string; name: string; cas_hash: string }>;
  runner?: { status: string; baseline_sha?: string | null; worktree_status?: string; auto_correct_count?: number; last_error_code?: string | null; human_instruction?: string | null; evidence_status?: string; evidence_error_code?: string | null; diff_bytes?: number; latest_attempt?: { id: string; task_id: string; attempt_no: number; status: string } | null };
  created_at: string;
}

export interface ContextSource {
  id: string;
  title: string;
  kind: string;
  path: string;
  content_hash: string;
}

export interface ContextPack {
  id: string;
  pack_hash: string;
  source_ids: string[];
  created_at: string;
}

export interface AssetVersion {
  id: string;
  name: string;
  media_type: string;
  byte_size: number;
  cas_hash: string;
  version: number;
  created_at: string;
}

export interface Review {
  id: string;
  project_id: string;
  execution_id?: string;
  kind: string;
  model_status: ModelSuggestionStatus;
  suggestion: Record<string, unknown>;
  decision?: { decision: 'approved' | 'rejected' | 'changes_requested'; note: string } | null;
  created_at: string;
}

export interface Delivery {
  id: string;
  project_id: string;
  execution_id?: string;
  status: 'draft' | 'ready' | 'submitted' | 'merged' | 'blocked' | 'cancelled';
  title: string;
  external_ref: string;
  revision: number;
  remote_status?: string;
  blocked_reason?: string | null;
  pull_number?: number | null;
  head_sha?: string | null;
  merge_sha?: string | null;
  branch?: string | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  created_at: string;
}

export type TerminalRuntime = 'linux_native' | 'windows_native';
export type TerminalStatus = 'ready' | 'running' | 'exited' | 'failed' | 'stopped' | 'orphaned';

export interface TerminalCapabilities {
  available: boolean;
  transport: string;
  protocols: string[];
  default_runtime: TerminalRuntime;
  max_preview_chars: number;
  linux_native: { available: boolean; runtime: TerminalRuntime; engine: string; reason?: string | null };
  windows_native: { available: boolean; runtime: TerminalRuntime; engine: string; git_bundle?: boolean; reason?: string | null };
}

export interface TerminalSession {
  id: string;
  project_id: string;
  assist_session_id: string | null;
  approval_id: string;
  runtime: TerminalRuntime;
  cwd: string;
  status: TerminalStatus;
  cols: number;
  rows: number;
  output_preview: string;
  output_bytes: number;
  output_sha256: string;
  output_truncated: boolean;
  artifact_asset_id: string | null;
  exit_code: number | null;
  error_code: string | null;
  revision: number;
  latest_cursor: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TerminalApproval {
  id: string;
  project_id: string;
  action: string;
  request: { runtime?: TerminalRuntime; cwd?: string; cols?: number; rows?: number };
  decision: 'pending' | 'approved' | 'rejected' | 'expired';
  expires_at: string;
  created_at: string;
  decided_at: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean; request_id: string; details: Record<string, unknown> };
}
