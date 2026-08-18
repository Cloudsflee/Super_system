import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../apps/api/src/database.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-db-'));
  const db = await openDatabase(path.join(directory, 'data', 'state.sqlite'));
  return { db, directory };
}

test('fresh database uses strict v4 settings and FTS5', async () => {
  const { db } = await fixture();
  const integrity = await db.integrity();
  assert.deepEqual(integrity.integrity, ['ok']);
  assert.equal(integrity.user_version, 6);
  assert.equal(integrity.migration_version, 6);
  assert.equal(integrity.journal_mode, 'wal');
  assert.equal(integrity.synchronous, 2);
  assert.ok((await db.get("SELECT name FROM sqlite_master WHERE name='context_source_fts'")));
  await db.close();
});

test('fresh database creates every recovery contract table as STRICT', async () => {
  const { db } = await fixture();
  const expected = [
    'users', 'sessions', 'connected_accounts', 'setup_states', 'codex_profiles', 'github_app_configs',
    'github_installations', 'mcp_clients', 'config_revisions', 'assist_sessions', 'assist_turns',
    'assist_messages', 'assist_events', 'assist_operations', 'assist_change_batches', 'assist_checkpoints',
    'attachments', 'runtime_approvals', 'runtime_user_inputs', 'ui_action_intents', 'file_changes',
    'project_intakes', 'workflow_drafts', 'workflow_generations', 'workflow_generation_events', 'node_contracts',
    'outcome_requirements', 'outcome_evaluations', 'outcome_waivers', 'execution_stage_checkpoints',
    'repository_connections', 'repository_targets', 'repository_lines', 'pull_request_intents',
    'delivery_policies', 'delivery_events', 'exchange_requests', 'exchange_grants', 'context_nodes',
    'context_document_versions', 'context_edges', 'context_selections', 'context_policies',
    'context_projection_jobs', 'context_summaries', 'asset_blobs', 'asset_attestations', 'asset_relations',
    'traces', 'digests', 'code_changes', 'test_results', 'quality_review_runs', 'quality_review_reports',
    'quality_review_events', 'operations', 'operation_events', 'setup_events', 'codex_discovery_sources',
    'github_repositories', 'github_webhook_deliveries', 'repository_line_artifacts',
    'workflow_layout_revisions', 'workflow_critic_receipts', 'node_contract_revisions',
    'workflow_generation_proposals'
  ];
  const rows = await db.query(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN (${expected.map(() => '?').join(',')})`, expected);
  assert.equal(rows.length, expected.length);
  assert.deepEqual(rows.map((row) => row.name).sort(), expected.toSorted());
  for (const row of rows) assert.match(row.sql, /\) STRICT$/i, row.name);
  await db.close();
});

test('transaction rolls back as one unit', async () => {
  const { db } = await fixture();
  await assert.rejects(() => db.transaction([
    { sql: 'INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: ['prj_rollback', 'rollback', 'now', 'now'] },
    { sql: 'INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: ['prj_rollback', 'duplicate', 'now', 'now'] }
  ]));
  assert.equal((await db.get('SELECT count(*) AS count FROM projects')).count, 0);
  await db.close();
});

test('brief revisions are immutable', async () => {
  const { db } = await fixture();
  await db.run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', ['prj_immutable', 'immutable', 'now', 'now']);
  await db.run('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)', ['prj_immutable', 1, '{}', '0'.repeat(64), 'now']);
  await assert.rejects(() => db.run('UPDATE brief_revisions SET content_json=? WHERE project_id=?', ['{"changed":true}', 'prj_immutable']), /immutable_record/);
  await db.close();
});

test('human review decisions are immutable', async () => {
  const { db } = await fixture();
  await db.run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', ['prj_decision', 'decision', 'now', 'now']);
  await db.run('INSERT INTO reviews(id,project_id,kind,model_status,suggestion_json,input_hash,created_at) VALUES(?,?,?,?,?,?,?)', ['rev_immutable', 'prj_decision', 'task', 'unavailable', '{}', '0'.repeat(64), 'now']);
  await db.run('INSERT INTO review_decisions(id,review_id,decision,note,created_at) VALUES(?,?,?,?,?)', ['dec_immutable', 'rev_immutable', 'approved', '', 'now']);
  await assert.rejects(() => db.run('UPDATE review_decisions SET decision=? WHERE id=?', ['rejected', 'dec_immutable']), /immutable_record/);
  await assert.rejects(() => db.run('DELETE FROM review_decisions WHERE id=?', ['dec_immutable']), /immutable_record/);
  await db.close();
});
