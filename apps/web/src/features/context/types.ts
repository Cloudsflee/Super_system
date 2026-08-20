export type ContextIndexStatus = {
  status: 'ready' | 'degraded' | 'unavailable';
  schema_version: string;
  snapshot_hash: string | null;
  index_hash: string | null;
  document_count: number;
};

export type ContextNode = {
  id: string;
  project_id: string;
  parent_id: string | null;
  uri: string;
  title: string;
  kind: string;
  node_kind?: string;
  source_type: string;
  source_id: string;
  source_revision: string;
  source_hash: string;
  current_document_version_id: string | null;
  sensitivity: string;
  authority: string;
  status: 'active' | 'tombstone';
  revision: number;
  required_scopes: string[];
  freshness: { status?: string; checked_at?: string };
  document?: ContextDocument | null;
};

export type ContextDocument = {
  id: string;
  node_id: string;
  version: number;
  content_hash: string;
  token_estimate: number;
  renderer_version: string;
  storage_kind: string;
  created_at: string;
  content?: string;
};

export type ContextMap = {
  schema_version: string;
  project_id: string;
  root_uri: string;
  nodes: ContextNode[];
  edges: Array<{ parent_id: string; child_id: string; relation: string; order_index: number }>;
  index: ContextIndexStatus;
};

export type ContextPolicy = {
  project_id: string;
  revision: number;
  hash: string;
  policy: {
    pinned_node_ids?: string[];
    excluded_node_ids?: string[];
    sensitivity_max?: string;
    freshness?: string;
  };
};

export type ContextSelection = {
  id: string;
  schema_version: string;
  selection_hash: string;
  policy_revision: number;
  token_budget?: number;
  token_used?: number;
  retrieval_plan: { token_budget?: number; query?: string | null; strategy?: string };
  included: Array<{ node_id: string; document_version_id: string; token_estimate: number; reason: string }>;
  excluded: Array<{ node_id: string; document_version_id: string | null; token_estimate: number; reason: string }>;
  created_at: string;
};

export type ContextPackView = {
  id: string;
  pack_hash: string;
  selection_id: string;
  selection_hash: string;
  policy_revision: number;
  schema_version: string;
  created_at: string;
  memory_manifest?: { document_version_ids?: string[]; brief_revision?: number; workflow_revision?: number };
  pack?: { schema_version?: string; memory_manifest?: { document_version_ids?: string[]; brief_revision?: number; workflow_revision?: number } };
};

export type ProjectionJob = {
  id: string;
  project_id: string;
  operation_id?: string | null;
  status: 'queued' | 'running' | 'indexing' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  mode: string;
  cursor: string;
  revision: number;
  attempt: number;
  retry_of_job_id?: string | null;
  error_code?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ProjectionStatus = ProjectionJob & { index: ContextIndexStatus; jobs: ProjectionJob[] };

export type McpTool = { name: string; description: string; input_schema?: Record<string, unknown> };
export type McpClient = {
  id: string;
  name: string;
  transport: string;
  endpoint: string;
  status: string;
  revision: number;
  subject: string;
  token_prefix: string;
  expires_at?: string | null;
  project_allowlist: string[];
  tool_allowlist: string[];
  scope: { project_ids?: string[]; tools?: string[] };
  token?: string;
};

export type ExchangeGrant = {
  id: string;
  request_id: string;
  source_project_id: string;
  target_project_id: string;
  grantee_actor_id?: string | null;
  status: string;
  revision: number;
  expires_at: string;
  revoked_at?: string | null;
  scope: { project_ids?: string[]; tools?: string[] };
};

export type ExchangeRequest = {
  id: string;
  source_project_id: string;
  target_project_id: string;
  source_approver_actor_id?: string | null;
  target_approver_actor_id?: string | null;
  grant_id?: string | null;
  status: string;
  revision: number;
  expires_at: string;
  scope: { project_ids?: string[]; tools?: string[] };
};
