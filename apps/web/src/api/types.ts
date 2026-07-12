export type StepState = { ready: boolean; status: string; detail?: string; checks?: Record<string, boolean>; profile_id?: string; installation_count?: number };
export type SetupState = {
  complete: boolean;
  mode: 'hosted' | 'byo' | null;
  can_complete: boolean;
  completed_at?: string | null;
  steps: { github: StepState; codex: StepState };
  reasons: string[];
};

export type DeploymentStatus = {
  mode: 'container' | 'host'; local_only: boolean;
  storage: { type: 'docker_volume' | 'local_directory'; ready: boolean };
  docker: { strategy: 'socket' | 'local_cli'; ready: boolean };
  imports: { codex_home: boolean; cc_switch: boolean; projects_root: boolean; project_path_mode: 'relative' | 'absolute' };
};

export type CodexWireApi = 'responses';
export type CodexAuthMetadata = {
  provider: string; base_url?: string | null; wire_api: CodexWireApi; auth_mode: 'device' | 'api_key' | 'discovery' | 'local_codex';
};
export type CodexStatus = {
  authenticated: boolean; auth?: CodexAuthMetadata | null;
  docker?: { available: boolean; version?: string }; image?: { ready: boolean; name: string };
  active_profile?: CodexProfile | null;
};
export type CodexProfile = {
  id: string; name: string; provider?: string; provider_name?: string; base_url?: string | null;
  wire_api?: CodexWireApi; model?: string; reasoning?: string; kind?: 'host' | 'docker' | string;
  status: string; is_active: boolean;
};
export type CodexProbePhase = 'configuration' | 'runtime' | 'binding' | 'transport' | 'protocol' | 'model' | 'inference';
export type CodexProbeCheck = {
  phase: CodexProbePhase; label: string; status: 'passed' | 'failed' | 'pending';
  error_code?: string; summary?: string; action?: string; retryable?: boolean;
};
export type CodexProbeReport = {
  ok: boolean; phase: CodexProbePhase; error_code?: string; summary?: string; action?: string; retryable?: boolean;
  checks?: CodexProbeCheck[]; process?: { exit_code: number | null; timed_out: boolean };
};
export type CcSwitchSource = {
  name: string; repo: string; status?: string; commit?: string | null; error?: string | null;
};
export type CcSwitchStatus = {
  status: string; local_path?: string; sources?: CcSwitchSource[]; updated_at?: string | null;
  providers?: Array<{ profile_id?: string; provider_id?: string; name?: string; provider?: string; base_url?: string; model?: string; wire_api?: string; sync_status?: string }>;
  bridge?: { ready?: boolean; revision?: string | number; mode?: string; implementation?: string };
};
export type CodexDiscoveryProvider = {
  discovery_id: string; name: string; provider: string; provider_name?: string;
  base_url?: string | null; model?: string | null; wire_api: CodexWireApi;
  requires_openai_auth?: boolean; has_credential: boolean; credential_hint?: string | null; credential_kind?: 'api_key' | 'oauth_bundle' | 'none';
  source_revision: string; importable?: boolean; issues?: string[]; is_current?: boolean; category?: string;
};
export type CodexDiscoverySource = {
  source_id: string; type: 'cc_switch' | 'codex_home'; display_name: string;
  status: string; path_hint?: string | null; revision: string | null;
  providers: CodexDiscoveryProvider[]; read_only?: boolean; issues?: string[];
};
export type CodexDiscovery = { updated_at?: string | null; sources: CodexDiscoverySource[] };
export type CodexDiscoveryImportInput = {
  discovery_id: string; source_revision: string; confirmed: true; api_key?: string; reconfigure?: true;
};
export type CodexDiscoveryImportResult = {
  profile: CodexProfile; authenticated: true;
  source: { source_id: string; type: CodexDiscoverySource['type']; revision: string | null };
  reconfiguration_started?: boolean;
};

export type Project = {
  id: string; title: string; goal: string; status: string;
  repo_path?: string; workspace_root?: string; current_workspace_id: string;
  workflow_count?: number; asset_count?: number; run_count?: number;
  onboarding_state?: string; managed_workspace_state?: string;
  deleted_at?: string | null; source_hash?: string | null;
};

export type ProjectIntakeMode = 'brainstorm' | 'existing';
export type ProjectCodeSource = {
  type: 'github' | 'git' | 'local_directory' | 'local_git' | 'archive';
  url?: string; repository_url?: string; path?: string; name?: string;
  path_scope?: 'host_import_root' | 'host_path' | 'managed_upload';
};
export type ProjectContextSource = {
  type: 'url' | 'text' | 'file' | 'image' | 'pdf' | 'docx' | 'xlsx';
  label?: string; url?: string; text?: string; path?: string; path_scope?: 'host_import_root' | 'managed_import'; sha256?: string | null;
};
export type ProjectIntakeAnswers = {
  goal?: string; users?: string[]; target_users?: string[];
  features?: string[]; scope_in?: string[]; scope_out?: string[];
  constraints?: string[]; milestones?: string[]; acceptance_criteria?: string[];
  risks?: string[]; open_questions?: string[];
};
export type ProjectIntake = {
  id: string; project_id: string; mode: ProjectIntakeMode | null; status: string;
  code_source?: ProjectCodeSource | null; context_sources: ProjectContextSource[];
  answers: ProjectIntakeAnswers; revision: number; last_error?: string | null;
  updated_at?: string;
};
export type ProjectBriefContent = {
  goal: string; users: string[]; scope: { in: string[]; out: string[] };
  features: string[]; constraints: string[]; milestones: string[];
  acceptance_criteria: string[]; risks: string[]; open_questions: string[];
};
export type ProjectBrief = {
  id: string; project_id: string; version: number; status: string;
  source: string; content: ProjectBriefContent; created_at: string; updated_at?: string;
};
export type WorkflowDraftNode = {
  type: NodeKind; title: string; goal: string; dependency_indexes: number[];
  position?: { x: number; y: number };
};
export type ProjectImportJob = {
  id: string; project_id: string; operation_key: string; kind?: string; status: string;
  error_code?: string; source_hash?: string; created_at: string; updated_at?: string;
};
export type ProjectOnboarding = {
  project: Project; intake: ProjectIntake; brief: ProjectBrief | null;
  briefs: ProjectBrief[]; workflow_draft: WorkflowDraftNode[]; imports: ProjectImportJob[];
  assist_session?: AssistSession | null; can_confirm: boolean; onboarding_route: string;
};
export type DraftProjectResult = {
  project: Project; intake: ProjectIntake; brief?: ProjectBrief | null;
  assist_session?: AssistSession; onboarding_route?: string; idempotent?: boolean;
};
export type Workflow = {
  id: string; project_id: string; title: string; status: string;
  graph_json?: { nodes?: unknown[]; edges?: unknown[] };
};
export type WorkflowNode = {
  id: string; workflow_id: string; workspace_id?: string; type: NodeKind;
  title: string; goal: string; status: string; order_index: number;
  dependencies: Array<{ node_id?: string; node_order?: number; type: string }>;
  position?: { x: number; y: number }; current_contract_id?: string;
  latest_run?: { id: string; status: string; completed_at?: string };
  output_count?: number; pending_approval_count?: number;
};
export type NodeKind = 'goal_definition' | 'research' | 'analysis' | 'execution' | 'retrospective';
export type NodeContract = {
  id: string; node_id: string; version: number; node_goal: string;
  acceptance_criteria: string[]; allowed_tools: string[];
  expected_inputs: Array<{ key: string; label: string; required: boolean; value?: string }>;
  expected_outputs: Array<{ label: string; required: boolean }>;
};
export type ProjectBundle = {
  project: Project; workflows: Workflow[]; nodes: WorkflowNode[];
  contracts: NodeContract[]; assets: AssetRecord[]; runs: RunRecord[];
};
export type AssetRecord = { id: string; title: string; type?: string; asset_type?: string; status: string; updated_at: string; project_id: string };
export type RunRecord = { id: string; node_id: string; status: string; summary: string; created_at: string };
export type CodeChangeRecord = { id: string; run_id: string; status: string; work_branch?: string; head_commit?: string; pr_url?: string };
export type TraceRecord = { id: string; event_type: string; summary: string; created_at?: string; occurred_at?: string; node_id?: string };
export type ChangeProposal = {
  id: string; project_id: string; node_id?: string; title: string; summary: string;
  change_type: string; status: string; before_json?: unknown; after_json?: unknown;
  risks?: string[]; impact?: string[]; evidence_refs?: string[]; created_at: string;
  attention_state?: 'interrupting' | 'queued' | 'resolved'; revision?: number; target_hash?: string;
};
export type ApprovalItemType = 'change_proposal' | 'runtime_approval';
export type ApprovalItem = {
  id: string; type: ApprovalItemType; project_id?: string; node_id?: string;
  title: string; summary: string; status: string;
  attention_state: 'interrupting' | 'queued' | 'resolved';
  revision: number; target_hash: string; created_at: string;
  change_type?: string; approval_type?: string; before_json?: unknown; after_json?: unknown;
  risks?: string[]; impact?: string[]; evidence_refs?: string[];
};
export type ApprovalDecision = 'approve_apply' | 'reject' | 'defer';
export type ApprovalDecisionResult = {
  item: ApprovalItem; applied?: Record<string, unknown>; proposal?: ChangeProposal;
};
export type AssistEvent = { id: number; type: string; data: Record<string, unknown>; created_at: string };
export type AssistMessage = { id: string; role: 'user' | 'assistant'; content: string; status: string; created_at: string };
export type AssistSession = {
  id: string; scope_type: string; scope_id: string; parent_session_id?: string;
  status: string; agent_session_id?: string; last_event_id?: number;
  messages?: AssistMessage[]; actions?: UiAction[];
};
export type UiAction = {
  id: string; name: string; label: string; status: string;
  risk: 'reversible' | 'confirm' | 'proposal'; args: Record<string, unknown>;
  result?: Record<string, unknown>;
};
export type FileEntry = { name: string; path: string; type: 'file' | 'directory'; size?: number };
export type NodeWorkspace = {
  project: Project; workflow: Workflow; node: WorkflowNode; contract: NodeContract;
  workspace: { id: string; title: string; open_questions: string[] };
  data: Record<string, unknown>; runs: RunRecord[]; code_changes: CodeChangeRecord[]; assets: AssetRecord[]; traces: TraceRecord[];
};

export type * from './assist-types';
