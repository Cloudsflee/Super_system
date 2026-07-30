export type ContextNodeRecord = {
  id: string;
  uri: string;
  kind: string;
  source_type: string;
  title: string;
  summary: string;
  project_id: string | null;
  parent_id: string | null;
  source_collection: string | null;
  source_id: string | null;
  source_version: number;
  status: string;
  sensitivity: string;
  authority: string;
  freshness: { status: string; source_updated_at?: string | null; checked_at?: string | null };
  current_version_id: string | null;
  required_scopes: string[];
  sort: { type_order: number; order_index: number; stable_id: string };
  resource: Record<string, unknown> | null;
};

export type ContextEdgeRecord = {
  id: string;
  type: string;
  source_node_id: string;
  target_node_id: string;
  order_index: number;
  source: Record<string, unknown>;
  version: number;
};

export type ContextDocumentVersion = {
  id: string;
  node_id: string;
  version: number;
  renderer_version: string;
  source_hash: string;
  content_sha256: string;
  size_bytes: number;
  media_type: string;
  token_estimate: number;
  deterministic_summary: string;
  redactions: Array<{ path: string; reason: string }>;
  created_at: string;
};

export type ContextPolicyRecord = {
  id?: string;
  actor_id?: string;
  session_id: string | null;
  project_id: string | null;
  pinned_node_ids: string[];
  excluded_node_ids: string[];
  revision: number;
  updated_at?: string;
};

export type ContextSelectionRecord = {
  id: string;
  schema_version: string;
  actor_id: string;
  session_id: string | null;
  project_id: string | null;
  anchor_node_id: string | null;
  candidate_node_ids: string[];
  included: Array<{
    node_id: string;
    document_version_id: string;
    content_sha256: string;
    token_estimate: number;
    reason: string;
  }>;
  excluded: Array<{
    node_id: string;
    document_version_id: string | null;
    token_estimate: number;
    reason: string;
  }>;
  token_budget: number;
  token_used: number;
  map_snapshot_hash: string;
  created_at: string;
  runtime_context?: {
    schema_version: string;
    purpose: 'mcp_search' | 'mcp_read_approved' | 'mcp_read' | 'mcp_read_denied';
    mcp_client_id: string;
    session_id?: string | null;
    run_id?: string | null;
    task_execution_id?: string | null;
    initial_context_selection_id: string;
    parent_context_selection_id?: string | null;
    read_node_id?: string | null;
    read_document_version_id?: string | null;
    incremental_token_budget: number;
    incremental_token_used: number;
    cumulative_token_used: number;
    total_token_budget: number;
  };
};

export type ContextMapResponse = {
  schema_version: string;
  uri: string;
  project_id: string | null;
  root_id: string;
  snapshot_hash: string;
  nodes: ContextNodeRecord[];
  edges: ContextEdgeRecord[];
  compact_markdown: string;
  policy: ContextPolicyRecord;
  latest_selection: ContextSelectionRecord | null;
  coverage?: { source_records: number; projected_records: number; tombstones: number; warnings: unknown[] };
};

export type ContextSearchResponse = {
  schema_version: string;
  query: string;
  project_id: string | null;
  snapshot_hash: string;
  results: Array<ContextNodeRecord & { score: number; terms: string[] }>;
  candidate_node_ids: string[];
  context_selection_id?: string;
  context_selection?: ContextSelectionRecord;
  approved_document_versions?: Array<{
    node_id: string;
    document_version_id: string;
    content_sha256: string;
    token_estimate: number;
  }>;
};

export type ContextNodeResponse = {
  schema_version: string;
  node: ContextNodeRecord;
  version: ContextDocumentVersion;
  markdown: string;
  facts: unknown;
  edges: ContextEdgeRecord[];
  related_nodes: ContextNodeRecord[];
  history: ContextDocumentVersion[];
  context_selection_id?: string;
  context_selection_ids?: string[];
  provenance_claim?: {
    document_version_id: string;
    context_selection_id: string;
    instruction: string;
  };
};

export type ContextStatusResponse = {
  schema_version: number;
  protocol_version: string;
  nodes: number;
  document_versions: number;
  edges: number;
  selections: number;
  jobs: Record<'pending' | 'running' | 'completed' | 'failed' | 'superseded', number>;
  worker: {
    state?: string;
    holder?: string;
    heartbeat_at?: string | null;
    worker_thread_id?: number | null;
    event_loop_lag_ms?: number;
    lease_ms?: number;
    batch_size?: number;
    active_leases?: number;
    oldest_pending_age_ms?: number;
    failed_jobs?: number;
    recovered_expired_leases?: number;
    index_generation?: number;
    automatic_rebuild?: string;
    last_error_code?: string | null;
  };
  oldest_pending_age_ms: number;
  active_leases: number;
  failed_jobs: number;
  index_generation: number;
  automatic_rebuild: string;
};
