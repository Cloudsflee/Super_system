import path from 'node:path';
import fs from 'node:fs';

export const ROOT = path.resolve(process.cwd());
export const AIWS_HOME = process.env.AIWS_HOME ? path.resolve(process.env.AIWS_HOME) : path.join(ROOT, '.ai-workspace');
export const DATA_DIR = path.join(AIWS_HOME, 'data');
export const ARTIFACT_DIR = path.join(AIWS_HOME, 'artifacts');
export const VAULT_DIR = path.join(AIWS_HOME, 'vault');
export const CODEX_HOME_DIR = path.join(AIWS_HOME, 'codex-homes');
export const WORKSPACE_DIR = path.join(AIWS_HOME, 'workspaces');
export const STAGING_DIR = path.join(AIWS_HOME, 'staging');
export const TRASH_DIR = path.join(AIWS_HOME, 'trash');
export const EXPORT_DIR = path.join(AIWS_HOME, 'exports');
export const WORKTREE_DIR = path.join(AIWS_HOME, 'worktrees');
export const PROBE_DIR = path.join(AIWS_HOME, 'probe-workspace');
export const ASSIST_DIR = path.join(AIWS_HOME, 'assist-workspaces');
export const ATTACHMENT_DIR = path.join(AIWS_HOME, 'attachments');
export const ATTACHMENT_TEMP_DIR = path.join(AIWS_HOME, 'attachment-staging');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const WEB_SOURCE_DIR = path.join(ROOT, 'apps', 'web');
export const WEB_DIST_DIR = path.join(WEB_SOURCE_DIR, 'dist');
export const WEB_DIR = fs.existsSync(WEB_DIST_DIR) ? WEB_DIST_DIR : WEB_SOURCE_DIR;
export const PORT = Number(process.env.PORT || process.env.AIWS_PORT || 4317);
export const LOCAL_GITHUB_APP_CONFIG = process.env.AIWS_GITHUB_APP_CONFIG ? path.resolve(process.env.AIWS_GITHUB_APP_CONFIG) : path.join(ROOT, 'config', 'github-app.local.example.json');

export const collections = [
  'users', 'sessions', 'connected_accounts', 'credential_refs', 'github_repositories',
  'projects', 'workspaces', 'workflows', 'workflow_nodes', 'node_contracts',
  'context_packs', 'context_sufficiency_checks', 'file_refs', 'traces',
  'assets', 'asset_versions', 'asset_relations', 'decisions', 'digests',
  'node_runs', 'agent_sessions', 'code_changes', 'tools', 'assist_sessions',
  'human_reviews', 'runner_memory_candidates', 'test_results',
  'change_proposals', 'submissions', 'codex_profiles', 'integration_statuses',
  'setup_states', 'github_app_configs', 'github_installations', 'repository_bindings',
  'assist_messages', 'assist_events', 'ui_action_intents', 'file_changes',
  'webhook_deliveries', 'node_workspace_data', 'test_tasks'
  ,'project_intakes', 'project_briefs', 'assist_turns', 'attachments', 'worktrees',
  'runtime_approvals', 'terminal_sessions', 'config_revisions', 'import_jobs',
  'assist_configurations', 'assist_change_batches', 'assist_checkpoints',
  'assist_operations', 'runtime_user_inputs', 'host_bridge_devices'
];

export function readLocalGithubAppConfig() {
  if (!fs.existsSync(LOCAL_GITHUB_APP_CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_GITHUB_APP_CONFIG, 'utf8')).github || {}; }
  catch { return {}; }
}
