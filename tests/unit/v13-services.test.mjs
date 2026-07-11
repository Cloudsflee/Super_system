import assert from 'node:assert/strict';
import { createDraftProjectRecords, validateContextSource } from '../../apps/api/src/project-lifecycle.mjs';
import { parseProviderList, CC_SWITCH_VERSION } from '../../apps/api/src/cc-switch-managed-cli.mjs';
import { probeCodexCapabilities, SUPPORTED_CODEX_VERSION } from '../../apps/api/src/codex-capabilities.mjs';
import { terminalCapability } from '../../apps/api/src/terminal-service.mjs';
import { PROJECT_IMPORT_LIMITS, validateArchiveRecords } from '../../apps/api/src/project-import-service.mjs';
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
