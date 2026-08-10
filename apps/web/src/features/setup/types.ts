export type SetupCheck =
  | 'owner'
  | 'active_codex_credential'
  | 'active_codex_profile'
  | 'current_codex_probe'
  | 'verified_github_app'
  | 'active_github_installation'
  | 'repository_permissions'
  | 'current_github_probe';

export interface Account {
  id: string;
  display_name: string;
  locale: string;
  timezone: string;
  status: string;
  revision: number;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
  revision: number;
  token?: string;
  token_issued?: boolean;
}

export interface Credential {
  id: string;
  provider: 'codex' | 'github';
  kind: 'codex_api_key' | 'codex_oauth_bundle' | 'github_app_private_key' | 'github_webhook_secret';
  label: string;
  origin: 'vault' | 'secret_bundle' | 'device_auth' | 'discovery';
  status: 'pending' | 'active' | 'expired' | 'revoked';
  revision: number;
  secret_version: number;
  expires_at: string | null;
  vault_backed: boolean;
}

export interface CodexProfile {
  id: string;
  label: string;
  provider: string;
  model: string;
  base_url: string;
  wire_api: 'responses' | 'chat';
  reasoning: 'low' | 'medium' | 'high';
  timeout_ms: number;
  credential_ref: string;
  status: string;
  revision: number;
  is_active: boolean;
  probe_status: string;
  probe_revision: number;
}

export interface GithubRepository {
  id?: string;
  github_id: string;
  full_name: string;
  selected: boolean;
  private?: boolean;
}

export interface GithubInstallation {
  id: string;
  installation_id: string;
  account_login: string;
  permissions: Record<string, string>;
  status: string;
  revision: number;
  last_probe_status: string;
  last_probe_code: string;
  repositories: GithubRepository[];
}

export interface GithubApp {
  id: string;
  label: string;
  app_id: string;
  client_id: string;
  status: string;
  revision: number;
  slug: string;
  probe_status: string;
  private_key_ref: string;
  webhook_secret_ref: string;
  installations: GithubInstallation[];
}

export interface SetupState {
  id: string;
  status: 'ready' | 'blocked';
  complete: boolean;
  can_complete: boolean;
  completed_at: string | null;
  revision: number;
  checks: Record<SetupCheck, boolean>;
  blockers: SetupCheck[];
  owner: Account;
  credentials: Credential[];
  codex_profiles: CodexProfile[];
  github_apps: GithubApp[];
}

export interface DiscoveryRecord {
  id: string;
  label: string;
  provider: string;
  model: string;
  wire_api: string;
  auth_kind: string;
  credential_available: boolean;
}

export interface DiscoverySource {
  id: string;
  source_type: string;
  display_name: string;
  source_revision: string;
  status: string;
  records: DiscoveryRecord[];
}

export interface OperationEvent {
  cursor: number;
  operation_id: string;
  type: string;
  data: { verification_url?: string; user_code?: string; status?: string; error_code?: string };
  created_at: string;
}

export interface Operation {
  id?: string;
  operation_id?: string;
  kind?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  resource_id?: string | null;
  revision: number;
  error_code?: string;
  result?: Record<string, unknown>;
}

export interface Capabilities {
  version: string;
  api: string;
  codex: { status: string; model?: string; checked_at?: string; error_code?: string | null };
  github: { provider?: string; status: string; checked_at?: string | null; error_code?: string | null };
  broker: { status: string; runner_digest: string };
}
