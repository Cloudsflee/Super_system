import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v15-core-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const powershellOps = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.ps1'), 'utf8');
  const posixOps = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.sh'), 'utf8');
  const backupTool = fs.readFileSync(path.join(process.cwd(), 'docker', 'backup_archive.py'), 'utf8');
  for (const script of [powershellOps, posixOps]) {
    assert.ok(script.includes('aiws-app:1.5.0'));
    assert.ok(script.includes('aiws-codex-runner:1.5.0-codex-0.144.0'));
    assert.ok(script.includes('state_canonical_hash'));
    assert.ok(script.includes('v15_restore_hash_mismatch'));
    assert.ok(script.includes('windows-bridge-export'));
  }
  for (const boundary of ['def create_archive', 'def sanitize_archive', 'def transient_codex_path', 'archive_symlink_target_outside']) assert.ok(backupTool.includes(boundary));
  const { resolveCodexInvocation } = await import('../../packages/runner-adapters/src/codex-command.mjs');
  assert.deepEqual(resolveCodexInvocation({ requested: '/tmp/fake-codex.mjs', platform: 'linux', exists: () => true, nodeExecutable: '/usr/bin/node' }), { command: '/usr/bin/node', args: ['/tmp/fake-codex.mjs'], source: 'node:/tmp/fake-codex.mjs' });

  const migration = await import('../../apps/api/src/state-migration-v14.mjs');
  const legacy = {
    schema_version: 13,
    codex_profiles: [
      { id: 'profile-base', status: 'validated', model: 'gpt-base', reasoning: 'high' },
      { id: 'profile-legacy', assist_configuration: true, base_profile_id: 'profile-base', name: 'Legacy config', model: 'gpt-saved', reasoning: 'ultra', api_key: 'must-not-copy' }
    ],
    assist_sessions: [{ id: 'session-legacy', version: 3, codex_thread_id: 'legacy-native-thread' }],
    ui_action_intents: [{ id: 'intent-legacy', status: 'confirmed' }]
  };
  const migrated = migration.migrateState13To14(legacy, { timestamp: '2026-07-13T00:00:00.000Z' });
  assert.equal(migrated.state.schema_version, 14);
  for (const collection of migration.V14_COLLECTIONS) assert.ok(Array.isArray(migrated.state[collection]), collection);
  assert.deepEqual(migrated.state.assist_configurations[0], {
    id: migrated.state.assist_configurations[0].id, name: 'Legacy config', base_profile_id: 'profile-base', model: 'gpt-saved', reasoning: 'ultra',
    legacy_profile_id: 'profile-legacy', migrated_from: 'v1.4_codex_profile', created_by_user_id: null,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  });
  assert.equal(JSON.stringify(migrated.state.assist_configurations).includes('must-not-copy'), false);
  assert.equal(migrated.state.ui_action_intents[0].ledger_version, 'v1.4_history');
  assert.equal(migrated.state.ui_action_intents[0].undoable, false);
  assert.equal(migrated.state.assist_sessions[0].legacy_codex_thread_id, 'legacy-native-thread');
  assert.equal(migration.migrateState13To14(migrated.state).migrated, false);

  const migrationRoot = path.join(root, 'migration'), stateFile = path.join(migrationRoot, 'state.json');
  fs.mkdirSync(migrationRoot, { recursive: true });
  const original = `${JSON.stringify(legacy, null, 2)}\n`; fs.writeFileSync(stateFile, original);
  await assert.rejects(() => migration.migrateStateFileToV14(stateFile, {
    backupDirectory: path.join(migrationRoot, 'backups'),
    clock: () => new Date('2026-07-13T01:02:03.000Z'),
    afterReplace: () => { const error = new Error('failure injection'); error.code = 'injected_after_replace'; throw error; }
  }), /failure injection/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), original, 'failed migration restores schema 13 bytes');
  const manifest = JSON.parse(fs.readFileSync(path.join(migrationRoot, 'backups', 'state-schema13-2026-07-13T01-02-03-000Z.manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'rolled_back');
  assert.equal(manifest.error, 'injected_after_replace');

  const domain = await import('../../apps/api/src/assist-v3-domain.mjs');
  assert.equal(domain.normalizeTurnCollaborationMode({ mode: 'ask' }), 'default');
  assert.equal(domain.normalizeTurnCollaborationMode({ collaboration_mode: 'plan' }), 'plan');
  assert.throws(() => domain.normalizeTurnCollaborationMode({ mode: 'agent' }), (error) => error.payload?.error === 'assist_mode_removed');
  assert.throws(() => domain.normalizeTurnCollaborationMode({ mode: 'cli' }), (error) => error.payload?.error === 'assist_mode_removed');
  assert.equal(domain.isWritableTurn({ collaboration_mode: 'plan' }, { status: 'active', managed_workspace_state: 'ready' }), false);
  assert.equal(domain.normalizeAssistReasoning('MAX'), 'max');
  assert.equal(domain.normalizeAssistReasoning('ultra'), 'ultra');

  const context = await import('../../apps/api/src/assist-v3-context.mjs');
  const contextArgs = {
    turn: { prompt: 'USER_ORIGINAL_ONLY', code_access: 'read_only', code_read_only_reason: 'plan', view_context: { route: '/project', surface: { revision: 'r1' } } },
    session: { scope_type: 'project', scope_id: 'project-v15', native_thread_generation: 2 },
    project: { id: 'project-v15', title: 'HIDDEN_PROJECT_TITLE', goal: 'HIDDEN_PROJECT_GOAL', status: 'active', managed_workspace_state: 'ready' },
    contextPack: { content_json: { brief: 'HIDDEN_BRIEF' } }, attachments: []
  };
  const userInput = await context.appServerUserInput(contextArgs.turn.prompt, [], { file_refs: [] });
  assert.deepEqual(userInput, [{ type: 'text', text: 'USER_ORIGINAL_ONLY', text_elements: [] }]);
  const additional = context.applicationAdditionalContext(contextArgs);
  assert.equal(additional.length, 1); assert.equal(additional[0].kind, 'application');
  assert.ok(additional[0].value.includes('HIDDEN_PROJECT_TITLE'));
  assert.equal(additional[0].value.includes('USER_ORIGINAL_ONLY'), false);

  const stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const repo = path.join(root, 'readable-repo'); fs.mkdirSync(repo, { recursive: true });
  await stateApi.mutate((state) => {
    state.codex_profiles = [
      { id: 'profile-base', name: 'Base', status: 'validated', is_active: true, assist_configuration: false, provider: 'openai', kind: 'host', model: 'gpt-base', reasoning: 'high' },
      { id: 'profile-custom', name: 'Custom', status: 'validated', is_active: false, assist_configuration: false, provider: 'custom', kind: 'host', model: 'custom-verified', reasoning: 'ultra' }
    ];
    state.projects = [{ id: 'project-v15', title: 'V1.5', status: 'active', managed_workspace_state: 'ready', repo_path: repo, settings: {} }];
    state.assist_sessions = [{ id: 'session-v15', version: 3, project_id: 'project-v15', scope_type: 'project', scope_id: 'project-v15', archived_at: null, runtime_profile_id: null, native_thread_generation: 2, codex_thread_id: null }];
    state.assist_turns = [{ id: 'turn-secret', session_id: 'session-v15', project_id: 'project-v15', status: 'running', mode: 'default', collaboration_mode: 'default' }];
    state.assist_configurations = [];
  });

  const { listAssistModels } = await import('../../apps/api/src/assist-models.mjs');
  const catalog = await listAssistModels('profile-base', { rpc: async () => ({ result: { data: [
    { id: 'gpt-next', model: 'gpt-next', displayName: 'Next', isDefault: true, defaultReasoningEffort: 'max', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] }
  ], nextCursor: null } }) });
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort), ['max', 'ultra']);
  assert.equal((await stateApi.readState()).codex_profiles[0].model_catalog[0].model, 'gpt-next');
  const { saveAssistConfiguration } = await import('../../apps/api/src/assist-v3-configurations.mjs');
  const saved = await saveAssistConfiguration({ base_profile_id: 'profile-base', name: 'Max config', model: 'gpt-next', reasoning: 'ultra' });
  assert.equal(saved.reasoning, 'ultra');
  const fallback = await listAssistModels('profile-custom', { rpc: async () => { throw new Error('no catalog'); } });
  assert.equal(fallback.source, 'verified_profile_fallback');
  assert.equal(fallback.models[0].model, 'custom-verified');

  const goals = await import('../../apps/api/src/assist-goals.mjs');
  const goalCalls = [];
  const rpc = async (request) => {
    goalCalls.push(request);
    if (request.method === 'thread/goal/clear') return { thread_id: 'native-v15', result: {} };
    const status = request.params.status || 'active';
    return { thread_id: 'native-v15', result: { goal: { objective: request.params.objective || 'Ship V1.5', status, tokenBudget: request.params.tokenBudget || 9000, tokensUsed: 321, timeUsedSeconds: 12 } } };
  };
  const setGoal = await goals.setAssistGoal('session-v15', { objective: 'Ship V1.5', tokenBudget: 9000, profile_id: 'profile-base' }, { rpc });
  assert.equal(setGoal.goal.tokenBudget, 9000);
  assert.equal(goalCalls[0].createThread, true); assert.equal(goalCalls[0].resumeId, null);
  await goals.getAssistGoal('session-v15', { rpc });
  assert.equal(goalCalls[1].method, 'thread/goal/get'); assert.equal(goalCalls[1].resumeId, 'native-v15');
  assert.deepEqual(await goals.clearAssistGoal('session-v15', { rpc }), { goal: null });

  const inputs = await import('../../apps/api/src/assist-user-input.mjs');
  const waiting = inputs.waitForAssistUserInput('session-v15', 'turn-secret', { itemId: 'credential', questions: [{ id: 'token', header: 'Secret', question: 'Token?', isSecret: true }] });
  await waitUntil(async () => (await stateApi.readState()).runtime_user_inputs.length === 1);
  await inputs.respondToAssistUserInput('turn-secret', 'credential', { answers: { token: { answers: ['SECRET_ANSWER_NEVER_PERSIST'] } } });
  assert.deepEqual(await waiting, { answers: { token: { answers: ['SECRET_ANSWER_NEVER_PERSIST'] } } });
  const persisted = await fsp.readFile(path.join(process.env.AIWS_HOME, 'data', 'state.json'), 'utf8');
  assert.equal(persisted.includes('SECRET_ANSWER_NEVER_PERSIST'), false);
  assert.equal((await stateApi.readState()).runtime_user_inputs[0].status, 'responded');
  console.log('V1.5 core unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('condition_timeout');
}
