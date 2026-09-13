export type P3Project = {
  id: string;
  team_id?: string;
  owner_actor_id?: string;
  name: string;
  description?: string;
  status: string;
  onboarding_state?: string;
  current_brief_revision?: number;
  confirmed_brief_revision?: number | null;
  confirmed_brief_hash?: string;
  current_workflow_revision?: number;
  revision: number;
  updated_at?: string;
};
export type Intake = {
  id: string;
  project_id: string;
  status: string;
  mode: 'brainstorm' | 'existing';
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  error_code?: string;
  attempt?: number;
  revision: number;
  operation_id?: string | null;
};
export type Brief = {
  id?: string;
  project_id: string;
  status?: string;
  current_revision?: number;
  confirmed_revision?: number | null;
  confirmed_hash?: string;
  revision?: number;
  current?: { revision: number; content?: Record<string, unknown>; content_sha256?: string } | null;
};
export type RepositoryConnection = {
  id: string;
  project_id: string;
  provider?: string;
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  status: string;
  read_only?: boolean;
  revision: number;
};
export type RepositoryTarget = {
  id: string;
  connection_id: string;
  name?: string;
  source_locator?: string;
  remote_ref?: string;
  expected_head_sha?: string;
  revision: number;
};
export type RepositoryDeletionIntent = {
  id: string;
  status: string;
  revision: number;
  target_full_name?: string;
  expected_head_sha?: string;
  error_code?: string | null;
};
export type RepositoryLine = { id: string; status: string; source_revision?: string; source_hash?: string; revision: number; fault_code?: string };
export type Workflow = { id: string; project_id: string; status: string; current_revision: number; revision: number; current?: { graph?: Record<string, unknown>; graph_sha256?: string; layout?: Record<string, unknown> } | null };
export type Generation = {
  id: string; phase: string; revision: number; attempt?: number; error_code?: string; operation_id?: string;
  source_workflow_revision?: number; candidate_sha256?: string; created_at?: string; updated_at?: string;
  proposal_id?: string | null; critic_receipt_id?: string | null; candidate?: Record<string, unknown>;
  critic?: { status?: string; candidate_sha256?: string; issues?: Array<{ code?: string; message?: string; node_id?: string; severity?: string }>; coverage?: Record<string, unknown> } | null;
  proposal?: { candidate?: Record<string, unknown>; base_workflow_revision: number; status?: string; candidate_sha256?: string; proposal_sha256?: string; revision?: number } | null;
};
export type GenerationTimelineItem = Generation;
export type Requirement = { id: string; requirement_key: string; workflow_revision: number; revision: number; rubric?: Record<string, unknown> };

export type BriefDraft = { objective: string; acceptance: string[] };
export type ProviderProfile = { id: string; provider: string; label?: string; status: string; lifecycle_status?: string; revision: number };
export type RunnerProfile = { id: string; label: string; runner_type?: string; status: string; revision: number };
export type ContextPack = { id: string; status: string; pack_hash: string };
