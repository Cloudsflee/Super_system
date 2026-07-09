import path from 'node:path';

export const ROOT = path.resolve(process.cwd());
export const AIWS_HOME = process.env.AIWS_HOME ? path.resolve(process.env.AIWS_HOME) : path.join(ROOT, '.ai-workspace');
export const DATA_DIR = path.join(AIWS_HOME, 'data');
export const ARTIFACT_DIR = path.join(AIWS_HOME, 'artifacts');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const WEB_DIR = path.join(ROOT, 'apps', 'web');
export const PORT = Number(process.env.PORT || process.env.AIWS_PORT || 4317);

export const collections = [
  'users', 'sessions', 'connected_accounts', 'credential_refs', 'github_repositories',
  'projects', 'workspaces', 'workflows', 'workflow_nodes', 'node_contracts',
  'context_packs', 'context_sufficiency_checks', 'file_refs', 'traces',
  'assets', 'asset_versions', 'asset_relations', 'decisions', 'digests',
  'node_runs', 'agent_sessions', 'code_changes', 'tools', 'assist_sessions',
  'human_reviews', 'runner_memory_candidates', 'test_results'
];
