import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, repositorySnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v13-migration-');
const external = path.join(fixture.root, 'legacy-external-repo');
const stateFile = path.join(fixture.home, 'data', 'state.json');
const createdAt = new Date(0).toISOString();
fs.mkdirSync(external, { recursive: true });
run('git', ['init'], external);
run('git', ['config', 'user.email', 'migration@example.test'], external);
run('git', ['config', 'user.name', 'Migration Fixture'], external);
fs.writeFileSync(path.join(external, 'README.md'), '# Legacy external source\n', 'utf8');
run('git', ['add', '.'], external);
run('git', ['commit', '-m', 'legacy baseline'], external);
const externalBefore = repositorySnapshot(external);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(legacyState(), null, 2), 'utf8');

const port = Number(process.env.AIWS_TEST_PORT || 4598);
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  let migrated = readState();
  const project = migrated.projects.find((item) => item.id === 'prj_legacy_v12');
  assert.equal(migrated.schema_version, 18);
  assert.equal(project.status, 'active');
  assert.equal(project.onboarding_state, 'confirmed');
  assert.equal(project.managed_workspace_state, 'workspace_migration_required');
  assert.equal(project.github_account_id, null);
  assert.equal(project.source_metadata, null);
  assert.equal(project.trash_metadata, null);
  for (const collection of ['project_intakes', 'project_briefs', 'assist_turns', 'attachments', 'worktrees', 'runtime_approvals', 'terminal_sessions', 'config_revisions', 'import_jobs']) assert.ok(Array.isArray(migrated[collection]), collection);
  for (const collection of ['assist_configurations', 'assist_change_batches', 'assist_checkpoints', 'assist_operations', 'runtime_user_inputs', 'host_bridge_devices']) assert.ok(Array.isArray(migrated[collection]), collection);
  for (const collection of ['brief_templates', 'workflow_drafts']) assert.ok(Array.isArray(migrated[collection]), collection);
  assert.ok(Array.isArray(migrated.mcp_clients));

  const proposal = migrated.change_proposals.find((item) => item.id === 'cpr_legacy_pending');
  assert.equal(proposal.attention_state, 'queued');
  assert.equal(proposal.revision, 1);
  assert.match(proposal.target_hash, /^[a-f0-9]{64}$/);
  assert.equal(migrated.terminal_sessions.find((item) => item.id === 'tty_legacy_running').status, 'interrupted');
  assert.equal(migrated.assist_turns.find((item) => item.id === 'atrn_legacy_running').status, 'interrupted');
  assert.equal(migrated.assist_sessions.find((item) => item.id === 'asst_legacy_v2').version, 2);
  const migratedV3 = migrated.assist_sessions.find((item) => item.id === 'asst_legacy_v3');
  assert.equal(migratedV3.forked_from_session_id, null); assert.equal(migratedV3.delete_batch_id, null);
  assert.equal(migratedV3.clarification_policy, 'ask');
  assert.equal(migrated.assist_turns.find((item) => item.id === 'atrn_legacy_running').codex_turn_id, null);
  const migrationManifest = JSON.parse(fs.readFileSync(path.join(fixture.home, 'data', 'migrations', fs.readdirSync(path.join(fixture.home, 'data', 'migrations')).find((item) => item.endsWith('.manifest.json'))), 'utf8'));
  assert.equal(migrationManifest.from_schema, 12); assert.equal(migrationManifest.to_schema, 18); assert.equal(migrationManifest.status, 'committed');

  const v2 = await api(port, '/assist/v2/sessions/asst_legacy_v2');
  assert.equal(v2.messages[0].content, 'legacy message is preserved');
  await api(port, '/assist/v2/sessions/asst_legacy_v2/messages?adapter=test', 'POST', {
    adapter: 'test', content: 'continue legacy session',
    test_response: { message: 'legacy session continued', actions: [{ name: 'git_commit', label: 'Blocked legacy commit', args: { message: 'must not touch external source' } }] }
  }, 202);
  const continued = await waitForV2Complete();
  assert.equal(continued.messages.at(-1).content, 'legacy session continued');
  const gitAction = continued.actions.find((item) => item.name === 'git_commit');
  assert.ok(gitAction);
  await api(port, `/assist/v2/sessions/asst_legacy_v2/actions/${gitAction.id}/confirm`, 'POST', {}, 409, 'workspace_migration_required');
  await api(port, '/projects/prj_legacy_v12/files/content', 'PUT', { path: 'README.md', content: '# blocked\n' }, 409, 'workspace_migration_required');
  await api(port, '/assist/v3/sessions/asst_legacy_v3/turns', 'POST', { adapter: 'test', mode: 'agent', content: 'must not write unmanaged source' }, 410, 'assist_mode_removed');
  await api(port, '/assist/v3/terminal-sessions', 'POST', { project_id: 'prj_legacy_v12' }, 409, 'workspace_migration_required');
  assert.deepEqual(repositorySnapshot(external), externalBefore);

  const managed = await api(port, '/projects/prj_legacy_v12/managed-workspace/migrate', 'POST', { operation_key: 'legacy-migration-1' });
  assert.equal(managed.managed_workspace_state, 'ready');
  assert.match(path.resolve(managed.repo_path), new RegExp(`${escapeRegExp(path.join(fixture.home, 'workspaces'))}`));
  await api(port, '/projects/prj_legacy_v12/files/content', 'PUT', { path: 'README.md', content: '# Managed legacy copy\n' });
  assert.equal(fs.readFileSync(path.join(managed.repo_path, 'README.md'), 'utf8'), '# Managed legacy copy\n');
  assert.deepEqual(repositorySnapshot(external), externalBefore);
  migrated = readState();
  assert.equal(migrated.assist_sessions.find((item) => item.id === 'asst_legacy_v2').version, 2);
  console.log('V1.3 legacy migration integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

function legacyState() {
  return {
    schema_version: 12,
    projects: [{ id: 'prj_legacy_v12', title: 'Legacy V1.2 Project', goal: 'preserve and migrate', repo_path: external, workspace_root: external, current_workspace_id: null, settings: { token_budget: 12000, preferred_runner: 'codex' }, created_at: createdAt, updated_at: createdAt }],
    assist_sessions: [
      { id: 'asst_legacy_v2', version: 2, project_id: 'prj_legacy_v12', scope_type: 'project', scope_id: 'prj_legacy_v12', status: 'idle', created_at: createdAt, updated_at: createdAt },
      { id: 'asst_legacy_v3', version: 3, project_id: 'prj_legacy_v12', scope_type: 'project', scope_id: 'prj_legacy_v12', status: 'running', lifecycle: 'active', created_at: createdAt, updated_at: createdAt }
    ],
    assist_messages: [{ id: 'amsg_legacy', session_id: 'asst_legacy_v2', role: 'user', content: 'legacy message is preserved', status: 'completed', created_at: createdAt }],
    assist_events: [],
    assist_turns: [{ id: 'atrn_legacy_running', session_id: 'asst_legacy_v3', project_id: 'prj_legacy_v12', mode: 'ask', prompt: 'legacy running turn', status: 'running', created_at: createdAt, updated_at: createdAt }],
    change_proposals: [{ id: 'cpr_legacy_pending', project_id: 'prj_legacy_v12', title: 'Legacy pending proposal', status: 'pending', before_json: { value: 1 }, after_json: { value: 2 }, created_at: createdAt, updated_at: createdAt }],
    terminal_sessions: [{ id: 'tty_legacy_running', project_id: 'prj_legacy_v12', status: 'running', created_at: createdAt, updated_at: createdAt }]
  };
}
function readState() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
async function waitForV2Complete() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const session = await api(port, '/assist/v2/sessions/asst_legacy_v2');
    if (session.status === 'completed') return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('legacy V2 session did not complete');
}
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
