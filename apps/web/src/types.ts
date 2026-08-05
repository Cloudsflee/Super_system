export type CapabilityStatus = 'available' | 'unavailable' | 'invalid';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  revision: number;
  updated_at: string;
  brief?: Brief | null;
  workflow?: Workflow | null;
  repository?: RepositoryBinding | null;
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
}

export interface WorkflowTask {
  id: string;
  title: string;
  level: 1 | 2;
  deps: string[];
  mode: 'read' | 'write';
  inputs: string[];
  outputs: string[];
}

export interface Workflow {
  project_id: string;
  revision: number;
  name: string;
  graph_hash: string;
  tasks: WorkflowTask[];
  created_at: string;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  attempt_no: number;
  status: 'pending' | 'ready' | 'running' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled';
  mode: string;
  error_code: string;
  output: Record<string, unknown>;
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
  model_status: CapabilityStatus;
  suggestion: Record<string, unknown>;
  decision?: { decision: 'approved' | 'rejected' | 'changes_requested'; note: string } | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  created_at: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean; request_id: string; details: Record<string, unknown> };
}
