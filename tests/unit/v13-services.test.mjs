import assert from 'node:assert/strict';
import path from 'node:path';
import { createDraftProjectRecords, validateContextSource } from '../../apps/api/src/project-lifecycle.mjs';
import { parseProviderList, CC_SWITCH_VERSION } from '../../apps/api/src/cc-switch-managed-cli.mjs';
import { probeCodexCapabilities, SUPPORTED_CODEX_VERSION } from '../../apps/api/src/codex-capabilities.mjs';
import { terminalCapability, terminalCodexArgs } from '../../apps/api/src/terminal-service.mjs';
import { PROJECT_IMPORT_LIMITS, validateArchiveRecords } from '../../apps/api/src/project-import-service.mjs';
import { cancelPendingTurnApprovals, publicErrorCode, readableProjectCwd, resolveAssistTurnConfiguration } from '../../apps/api/src/assist-v3-domain.mjs';
import { assistPageActionInstruction, materializeV3PageActions, parseV3AssistOutput } from '../../apps/api/src/assist-v3-actions.mjs';
import { buildCodexExecInvocation } from '../../apps/api/src/codex-exec-invocation.mjs';
import { ASSIST_DIR } from '../../apps/api/src/config.mjs';
import { preferAssistAppServer } from '../../apps/api/src/assist-v3-runtime.mjs';
import { createChangeProposal } from '../../packages/shared/index.mjs';

const actor = { id: 'usr_v13', role: 'owner' };
const draft = createDraftProjectRecords({ title: 'V1.3 Unit', mode: 'brainstorm', answers: { goal: '验证领域构造' } }, actor);
assert.equal(draft.project.status, 'draft');
assert.equal(draft.project.onboarding_state, 'intake');
assert.equal(draft.project.managed_workspace_state, 'empty');
assert.equal(draft.project.source_metadata, null);
assert.equal(draft.project.trash_metadata, null);
assert.equal(draft.intake.mode, 'brainstorm');
assert.equal(draft.brief.version, 1);
assert.equal(draft.session.version, 3);
assert.match(draft.onboarding_route, /\/onboarding$/);

const proposal = createChangeProposal({ projectId: draft.project.id, title: '治理', before: { value: 1 }, after: { value: 2 }, actorId: actor.id });
assert.equal(proposal.attention_state, 'interrupting');
assert.equal(proposal.revision, 1);
assert.match(proposal.target_hash, /^[a-f0-9]{64}$/);

const catalog = parseProviderList(`ID  Name  Current\n*  openrouter  OpenRouter\n   deepseek  DeepSeek`);
assert.deepEqual(catalog, [
  { id: 'openrouter', name: 'OpenRouter', current: true },
  { id: 'deepseek', name: 'DeepSeek', current: false }
]);
assert.equal(CC_SWITCH_VERSION, '5.9.0');

const capability = probeCodexCapabilities({ adapted: true, profile: { kind: 'host' } });
assert.equal(capability.compatible, true);
assert.equal(capability.guided_transport, 'app-server');
assert.equal(capability.host.version, SUPPORTED_CODEX_VERSION);
assert.equal(capability.host.tty, true);
assert.equal(terminalCapability().transport, 'node-pty+websocket');
assert.deepEqual(terminalCodexArgs({ model: 'gpt-terminal', reasoning: 'low' }), ['--model', 'gpt-terminal', '-c', 'model_reasoning_effort="low"']);

assert.equal(readableProjectCwd({ id: 'prj_draft', repo_path: path.join(ASSIST_DIR, 'missing-repo') }), path.join(ASSIST_DIR, 'prj_draft'));
assert.equal(publicErrorCode(new Error('runner_mount_outside_data_volume')), 'assist_workspace_unavailable');
const startFailure = new Error('spawn failed'); startFailure.code = 'app_server_start_failed';
assert.equal(publicErrorCode(startFailure), 'codex_runtime_start_failed');
assert.equal(preferAssistAppServer({ provider: 'custom' }, { guided_transport: 'app-server' }), false);
assert.equal(preferAssistAppServer({ provider: 'openai' }, { guided_transport: 'app-server' }), true);
assert.equal(preferAssistAppServer({ provider: 'openai' }, { guided_transport: 'exec-json' }), false);
const profileState = { codex_profiles: [{ id: 'profile-unit', status: 'validated', is_active: true, model: 'gpt-base', reasoning: 'medium' }] };
assert.deepEqual(resolveAssistTurnConfiguration(profileState, { model: 'gpt-override', reasoning: 'xhigh' }), { profile: profileState.codex_profiles[0], model: 'gpt-override', reasoning: 'xhigh' });
assert.throws(() => resolveAssistTurnConfiguration(profileState, { model: '../invalid model' }), (error) => error.payload?.error === 'invalid_assist_model');
assert.throws(() => resolveAssistTurnConfiguration(profileState, { reasoning: 'maximum' }), (error) => error.payload?.error === 'invalid_assist_reasoning');
const execInvocation = buildCodexExecInvocation({ profile: { id: 'profile-unit', kind: 'host', model: 'gpt-override', reasoning: 'xhigh' }, prompt: 'PRIVATE_PROMPT', cwd: process.cwd(), sandbox: 'read-only' });
const reasoningArg = execInvocation.args.indexOf('-c');
assert.equal(execInvocation.args[reasoningArg + 1], 'model_reasoning_effort="xhigh"');
assert.ok(execInvocation.args.includes('gpt-override'));
assert.equal(execInvocation.safeArgs.includes('PRIVATE_PROMPT'), false);

const viewContext = { route: '/projects/p1/onboarding', surface: { fields: [{ id: 'brief.goal', label: '核心目标' }, { id: 'brief.risks', label: '风险' }] } };
assert.match(assistPageActionInstruction(viewContext), /brief\.goal/);
const parsedPageOutput = parseV3AssistOutput('## 已整理\n\n请审查。\n<aiws_actions>{"actions":[{"name":"fill_field","label":"填写目标","args":{"field_id":"brief.goal","value":"交付可验证结果"}},{"name":"fill_field","args":{"field_id":"brief.unknown","value":"越界"}},{"name":"fill_field","args":{"field_id":"brief.risks","value":"风险","selector":"#root"}}]}</aiws_actions>');
assert.equal(parsedPageOutput.message, '## 已整理\n\n请审查。');
const pageActionState = { ui_action_intents: [] };
const pageActions = materializeV3PageActions(pageActionState, { session: { id: 'session-unit', project_id: 'p1', workspace_id: 'w1', node_id: null }, turn: { id: 'turn-unit', view_context: viewContext }, sourceMessageId: 'message-unit', inputs: parsedPageOutput.actions });
assert.equal(pageActions.length, 1);
assert.deepEqual(pageActions[0].args, { field_id: 'brief.goal', value: '交付可验证结果' });
assert.equal(pageActionState.ui_action_intents.length, 1);
const approvalState = { runtime_approvals: [{ id: 'rap_pending', turn_id: 'turn_failed', status: 'pending', attention_state: 'interrupting', revision: 1 }, { id: 'rap_other', turn_id: 'turn_other', status: 'pending', attention_state: 'interrupting', revision: 1 }] };
assert.equal(cancelPendingTurnApprovals(approvalState, 'turn_failed', 'codex_turn_failed'), 1);
assert.deepEqual(approvalState.runtime_approvals[0], { id: 'rap_pending', turn_id: 'turn_failed', status: 'cancelled', attention_state: 'resolved', revision: 2, cancelled_reason: 'codex_turn_failed', cancelled_at: approvalState.runtime_approvals[0].cancelled_at, updated_at: approvalState.runtime_approvals[0].updated_at });
assert.equal(approvalState.runtime_approvals[1].status, 'pending');

assert.equal(validateContextSource({ type: 'url', url: 'https://example.com/spec' }).type, 'url');
for (const url of ['http://example.com', 'https://localhost/a', 'https://127.0.0.1/a', 'https://user:pass@example.com/a', 'https://example.com/a?token=secret']) {
  assert.throws(() => validateContextSource({ type: 'url', url }), /unsafe_context_url/);
}

assert.deepEqual(validateArchiveRecords([
  { path: 'repo/', type: 'directory', size: null },
  { path: 'repo/README.md', type: 'file', size: 12 }
]), { entries: 2, total_bytes: 12 });
for (const archivePath of ['../escape', '/absolute/file', 'C:/absolute/file', 'repo/../../escape']) {
  assert.throws(() => validateArchiveRecords([{ path: archivePath, type: 'file', size: 1 }]), /archive_path_traversal/);
}
for (const type of ['symlink', 'hardlink', 'link']) {
  assert.throws(() => validateArchiveRecords([{ path: 'repo/link', type, size: 0 }]), /archive_link_rejected/);
}
assert.throws(
  () => validateArchiveRecords(Array.from({ length: PROJECT_IMPORT_LIMITS.files + 1 }, (_, index) => ({ path: `repo/${index}`, type: 'file', size: 0 }))),
  /source_file_count_exceeded/
);
assert.throws(() => validateArchiveRecords([{ path: 'repo/large', type: 'file', size: PROJECT_IMPORT_LIMITS.fileBytes + 1 }]), /source_file_too_large/);
assert.throws(() => validateArchiveRecords(Array.from({ length: 9 }, (_, index) => ({ path: `repo/total-${index}`, type: 'file', size: PROJECT_IMPORT_LIMITS.fileBytes }))), /source_total_size_exceeded/);
console.log('V1.3 service unit tests passed');
