export type CodexWireApi = 'responses';
export type CodexAuthMetadata = {
  provider: string;
  base_url?: string | null;
  wire_api: CodexWireApi;
  auth_mode: 'device' | 'api_key' | 'discovery' | 'local_codex';
};
export type CodexStatus = {
  authenticated: boolean;
  auth?: CodexAuthMetadata | null;
  docker?: { available: boolean; version?: string };
  image?: { ready: boolean; name: string };
  active_profile?: CodexProfile | null;
};
export type CodexBuildLog = { at: string; stream: 'stdout' | 'stderr' | string; text: string };
export type CodexBuildOperation = {
  operation_id: string;
  image: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: { key: string; label: string; index: number; total: number };
  started_at: string;
  updated_at: string;
  completed_at?: string | null;
  elapsed_ms: number;
  error_code?: string | null;
  message?: string;
  action?: string | null;
  retryable?: boolean;
  latest_log?: string;
  logs: CodexBuildLog[];
  last_event_id?: number;
};
export type CodexBuildStart = {
  operation_id?: string;
  status?: string;
  attached?: boolean;
  events_url?: string;
  cancel_url?: string;
  operation?: CodexBuildOperation;
};
export type CodexProfile = {
  id: string;
  name: string;
  provider?: string;
  provider_name?: string;
  base_url?: string | null;
  wire_api?: CodexWireApi;
  model?: string;
  reasoning?: string;
  kind?: 'host' | 'docker' | string;
  timeout_ms?: number;
  status: string;
  is_active: boolean;
  assist_configuration?: boolean;
  base_profile_id?: string | null;
};
export type CodexProbePhase =
  'configuration' | 'runtime' | 'binding' | 'transport' | 'protocol' | 'model' | 'inference';
export type CodexProbeCheck = {
  phase: CodexProbePhase;
  label: string;
  status: 'passed' | 'failed' | 'pending';
  error_code?: string;
  summary?: string;
  action?: string;
  retryable?: boolean;
};
export type CodexProbeReport = {
  ok: boolean;
  phase: CodexProbePhase;
  error_code?: string;
  summary?: string;
  action?: string;
  retryable?: boolean;
  checks?: CodexProbeCheck[];
  process?: { exit_code: number | null; timed_out: boolean };
};
export type CcSwitchSource = {
  name: string;
  repo: string;
  status?: string;
  commit?: string | null;
  error?: string | null;
};
export type CcSwitchStatus = {
  status: string;
  local_path?: string;
  sources?: CcSwitchSource[];
  updated_at?: string | null;
  providers?: Array<{
    profile_id?: string;
    provider_id?: string;
    name?: string;
    provider?: string;
    base_url?: string;
    model?: string;
    wire_api?: string;
    sync_status?: string;
  }>;
  bridge?: { ready?: boolean; revision?: string | number; mode?: string; implementation?: string };
};
export type CodexDiscoveryProvider = {
  discovery_id: string;
  name: string;
  provider: string;
  provider_name?: string;
  base_url?: string | null;
  model?: string | null;
  wire_api: CodexWireApi;
  requires_openai_auth?: boolean;
  has_credential: boolean;
  credential_hint?: string | null;
  credential_kind?: 'api_key' | 'oauth_bundle' | 'none';
  source_revision: string;
  importable?: boolean;
  issues?: string[];
  is_current?: boolean;
  category?: string;
};
export type CodexDiscoverySource = {
  source_id: string;
  type: 'cc_switch' | 'codex_home';
  display_name: string;
  status: string;
  path_hint?: string | null;
  revision: string | null;
  providers: CodexDiscoveryProvider[];
  read_only?: boolean;
  issues?: string[];
};
export type CodexDiscovery = { updated_at?: string | null; sources: CodexDiscoverySource[] };
export type CodexDiscoveryImportInput = {
  discovery_id: string;
  source_revision: string;
  confirmed: true;
  api_key?: string;
  reconfigure?: true;
};
export type CodexDiscoveryImportResult = {
  profile: CodexProfile;
  authenticated: true;
  source: { source_id: string; type: CodexDiscoverySource['type']; revision: string | null };
  reconfiguration_started?: boolean;
};
