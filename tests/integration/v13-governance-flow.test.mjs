import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4596);
const fixture = makeFixture('aiws-v13-governance-');
const realCcSwitchFixture = path.join(fixture.ccSwitch, 'cc-switch.db');
fs.writeFileSync(realCcSwitchFixture, 'read-only-catalog-fixture', 'utf8');
const ccSwitchHash = sha256(realCcSwitchFixture);
let server;
let stateApi;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  process.env.AIWS_HOME = fixture.home;
  process.env.NODE_ENV = 'test';
  stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const created = await api(
    port,
    '/projects',
    'POST',
    {
      title: 'V1.3 Governance',
      mode: 'brainstorm',
      answers: { goal: '验证统一审批与配置治理' }
    },
    201
  );
  const projectId = created.project.id;
  await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {
    workflow_nodes: [
      {
        id: 'governance-workstream',
        role: 'workstream',
        title: '治理验证成果',
        outcome: '形成可审计治理结果',
        category: 'operation',
        acceptance_criteria: ['审批与配置变更可追溯'],
        boundary: { permissions: ['owner'] },
        dependency_ids: [],
        tasks: [
          {
            id: 'governance-task',
            role: 'task',
            title: '执行治理验证',
            task_kind: 'manual',
            execution_mode: 'manual',
            dependency_ids: []
          }
        ]
      }
    ]
  });

  const proposal = await api(
    port,
    '/change-proposals',
    'POST',
    {
      project_id: projectId,
      change_type: 'record_only',
      title: 'Atomic approval fixture',
      before: { value: 1 },
      after: { value: 2 },
      apply_action: { type: 'record_only' }
    },
    201
  );
  assert.equal(proposal.attention_state, 'interrupting');
  assert.equal(proposal.revision, 1);
  assert.ok(proposal.target_hash);
  const deferred = await api(port, `/approvals/proposal/${proposal.id}/decision`, 'POST', {
    decision: 'defer',
    revision: proposal.revision,
    target_hash: proposal.target_hash
  });
  assert.equal(deferred.item.attention_state, 'queued');
  assert.equal(deferred.item.revision, 2);
  await api(
    port,
    `/approvals/proposal/${proposal.id}/decision`,
    'POST',
    {
      decision: 'approve_apply',
      revision: 1,
      target_hash: proposal.target_hash
    },
    409,
    'proposal_stale'
  );
  const applied = await api(port, `/approvals/proposal/${proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: deferred.item.revision,
    target_hash: proposal.target_hash
  });
  assert.equal(applied.item.status, 'applied');
  assert.equal(applied.item.attention_state, 'resolved');
  assert.equal(applied.applied.type, 'record_only');
  const rejectedProposal = await api(
    port,
    '/change-proposals',
    'POST',
    {
      project_id: projectId,
      change_type: 'record_only',
      title: 'Reject fixture',
      before: { value: 1 },
      after: { value: 3 },
      apply_action: { type: 'record_only' }
    },
    201
  );
  const proposalRejected = await api(port, `/approvals/proposal/${rejectedProposal.id}/decision`, 'POST', {
    decision: 'reject',
    revision: rejectedProposal.revision,
    target_hash: rejectedProposal.target_hash,
    reason: 'not required'
  });
  assert.equal(proposalRejected.item.status, 'rejected');
  assert.equal(proposalRejected.item.attention_state, 'resolved');
  assert.equal(
    (
      await api(port, `/approvals/proposal/${rejectedProposal.id}/decision`, 'POST', {
        decision: 'reject',
        revision: proposalRejected.item.revision,
        target_hash: proposalRejected.item.target_hash
      })
    ).idempotent,
    true
  );
  const resolvedProposals = await api(port, `/approvals?project_id=${projectId}&type=proposal&state=resolved`);
  assert.equal(
    resolvedProposals.every((item) => item.type === 'proposal' && item.attention_state === 'resolved'),
    true
  );

  const runtimeId = 'rap_v13_fixture';
  await stateApi.mutate((state) => {
    state.runtime_approvals.push({
      id: runtimeId,
      project_id: projectId,
      turn_id: null,
      approval_type: 'command',
      status: 'pending',
      attention_state: 'interrupting',
      revision: 1,
      target_hash: 'runtime-target-v1',
      request: { command: 'node --version', api_key: 'sk-runtime-approval-secret' },
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    });
  });
  const approvals = await api(port, `/approvals?project_id=${projectId}`);
  assert.equal(
    approvals.some((item) => item.type === 'proposal' && item.id === proposal.id),
    true
  );
  assert.equal(
    approvals.some((item) => item.type === 'runtime' && item.id === runtimeId),
    true
  );
  const publicRuntime = approvals.find((item) => item.id === runtimeId);
  assert.equal(publicRuntime.title, 'Codex 请求执行命令');
  assert.match(publicRuntime.summary, /node --version/);
  assert.equal(JSON.stringify(publicRuntime).includes('sk-runtime-approval-secret'), false);
  const runtimeDeferred = await api(port, `/approvals/runtime/${runtimeId}/decision`, 'POST', {
    decision: 'defer',
    revision: 1,
    target_hash: 'runtime-target-v1'
  });
  assert.equal(runtimeDeferred.item.attention_state, 'queued');
  await api(
    port,
    `/approvals/runtime/${runtimeId}/decision`,
    'POST',
    {
      decision: 'approve_apply',
      revision: 1,
      target_hash: 'runtime-target-v1'
    },
    409,
    'proposal_stale'
  );
  const runtimeApproved = await api(port, `/approvals/runtime/${runtimeId}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: 2,
    target_hash: 'runtime-target-v1'
  });
  assert.equal(runtimeApproved.item.status, 'approved');
  assert.equal(runtimeApproved.item.attention_state, 'resolved');

  const capabilities = await api(port, '/codex/capabilities/probe', 'POST', { adapter: 'test', persist: true });
  assert.equal(capabilities.compatible, true);
  assert.equal(capabilities.guided_transport, 'app-server');
  assert.equal(capabilities.host.app_server, true);
  assert.equal(capabilities.host.exec_json, true);
  const terminal = await api(port, '/assist/v3/terminal-capabilities');
  assert.equal(typeof terminal.available, 'boolean');
  assert.equal(terminal.transport, 'node-pty+websocket');
  assert.ok(terminal.protocols.includes('resize'));

  const installed = await api(port, '/codex/cc-switch/managed/install', 'POST', { adapter: 'test' });
  assert.equal(installed.installed, true);
  assert.equal(installed.checksum_verified, true);
  assert.equal(installed.adapter, true);
  const catalog = await api(port, '/codex/cc-switch/managed/catalog?adapter=test');
  assert.equal(catalog.source, 'managed-cc-switch-cli');
  assert.ok(Array.isArray(catalog.providers));
  assert.equal(sha256(realCcSwitchFixture), ccSwitchHash);

  const profiles = await api(port, '/codex/profiles');
  const nativeDirect = await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      project_id: projectId,
      profile_id: profiles[0].id,
      patch: {
        name: 'Native Direct Provider',
        provider: 'native-direct',
        provider_name: 'Native Direct',
        base_url: 'https://native-direct.example/v1',
        model: 'native/direct-codex',
        reasoning: 'high',
        timeout_ms: 1_800_000
      }
    },
    201
  );
  assert.equal(nativeDirect.revision.apply_mode, 'native');
  assert.equal(typeof nativeDirect.proposal.before_json.timeout_ms, 'number');
  assert.equal(nativeDirect.proposal.after_json.timeout_ms, 1_800_000);
  const nativeDirectActivated = await api(port, `/approvals/proposal/${nativeDirect.proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: nativeDirect.proposal.revision,
    target_hash: nativeDirect.proposal.target_hash,
    adapter: 'test'
  });
  assert.equal(nativeDirectActivated.revision.reconciliation.mode, 'native-profile');
  assert.equal(nativeDirectActivated.profile.timeout_ms, 1_800_000);
  assert.equal(
    (await stateApi.readState()).integration_statuses.some((item) => item.key === 'cc_switch_managed'),
    false
  );

  const config = await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      project_id: projectId,
      profile_id: profiles[0].id,
      apply_mode: 'cc_switch',
      patch: {
        name: 'Governed Test Provider',
        provider: 'test-provider',
        provider_name: 'Test Provider',
        base_url: 'https://provider.example/v1',
        model: 'test/codex',
        reasoning: 'high'
      }
    },
    201
  );
  assert.equal(config.revision.status, 'proposed');
  assert.equal(config.proposal.attention_state, 'interrupting');
  const activated = await api(port, `/approvals/proposal/${config.proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: config.proposal.revision,
    target_hash: config.proposal.target_hash,
    adapter: 'test'
  });
  assert.equal(activated.revision.status, 'active');
  assert.equal(activated.proposal.status, 'applied');
  assert.equal(activated.profile.provider, 'test-provider');
  assert.equal(activated.revision.reconciliation.status, 'reconciled');
  assert.equal(activated.revision.reconciliation.mode, 'cc-switch-cli');
  const repeatedActivation = await api(port, `/approvals/proposal/${config.proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: activated.proposal.revision,
    target_hash: activated.proposal.target_hash,
    adapter: 'test'
  });
  assert.equal(repeatedActivation.idempotent, true);

  await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      profile_id: profiles[0].id,
      patch: { base_url: 'https://provider.example/v1?token=forbidden' }
    },
    400,
    'invalid_base_url'
  );
  await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      profile_id: profiles[0].id,
      patch: { mcp_servers: [{ name: 'unsafe', command: 'powershell', args: [] }] }
    },
    400,
    'invalid_codex_profile'
  );
  await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      profile_id: profiles[0].id,
      patch: { timeout_ms: 0 }
    },
    400,
    'invalid_codex_profile'
  );
  await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      profile_id: profiles[0].id,
      patch: { timeout_ms: '1800000' }
    },
    400,
    'invalid_codex_profile'
  );

  const rollbackConfig = await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      project_id: projectId,
      profile_id: profiles[0].id,
      apply_mode: 'cc_switch',
      patch: {
        name: 'Rollback Provider',
        provider: 'rollback-provider',
        provider_name: 'Rollback Provider',
        base_url: 'https://rollback.example/v1',
        model: 'rollback/codex',
        reasoning: 'high'
      }
    },
    201
  );
  await api(
    port,
    `/approvals/proposal/${rollbackConfig.proposal.id}/decision`,
    'POST',
    {
      decision: 'approve_apply',
      revision: rollbackConfig.proposal.revision,
      target_hash: rollbackConfig.proposal.target_hash,
      adapter: 'test',
      test_failure: 'rediscover'
    },
    409,
    'cc_switch_rediscovery_failed'
  );
  let failedState = await stateApi.readState();
  let failedRevision = failedState.config_revisions.find((item) => item.id === rollbackConfig.revision.id);
  assert.equal(failedRevision.status, 'failed');
  assert.equal(failedRevision.reconciliation.status, 'rolled_back');
  assert.equal(failedRevision.reconciliation.rollback.attempted, true);
  assert.equal(failedRevision.reconciliation.rollback.ok, true);
  assert.equal(failedState.codex_profiles.find((item) => item.id === profiles[0].id).provider, 'test-provider');
  const recovered = await api(port, `/approvals/proposal/${rollbackConfig.proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: rollbackConfig.proposal.revision,
    target_hash: rollbackConfig.proposal.target_hash,
    adapter: 'test'
  });
  assert.equal(recovered.revision.reconciliation.status, 'reconciled');
  assert.equal(recovered.profile.provider, 'rollback-provider');

  const manualConfig = await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      project_id: projectId,
      profile_id: profiles[0].id,
      apply_mode: 'cc_switch',
      patch: {
        name: 'Manual Provider',
        provider: 'manual-provider',
        provider_name: 'Manual Provider',
        base_url: 'https://manual.example/v1',
        model: 'manual/codex',
        reasoning: 'high'
      }
    },
    201
  );
  await api(
    port,
    `/approvals/proposal/${manualConfig.proposal.id}/decision`,
    'POST',
    {
      decision: 'approve_apply',
      revision: manualConfig.proposal.revision,
      target_hash: manualConfig.proposal.target_hash,
      adapter: 'test',
      test_failure: 'rediscover',
      test_rollback_failure: true
    },
    409,
    'cc_switch_rediscovery_failed'
  );
  failedState = await stateApi.readState();
  failedRevision = failedState.config_revisions.find((item) => item.id === manualConfig.revision.id);
  assert.equal(failedRevision.reconciliation.status, 'manual_reconciliation_required');
  assert.equal(failedRevision.reconciliation.rollback.ok, false);
  assert.equal(failedState.codex_profiles.find((item) => item.id === profiles[0].id).provider, 'rollback-provider');

  const nativeConfig = await api(
    port,
    '/codex/config-revisions',
    'POST',
    {
      project_id: projectId,
      profile_id: profiles[0].id,
      apply_mode: 'cc_switch',
      native_fallback: true,
      patch: {
        name: 'Native Provider',
        provider: 'native-provider',
        provider_name: 'Native Provider',
        base_url: 'https://native.example/v1',
        model: 'native/codex',
        reasoning: 'high'
      }
    },
    201
  );
  await api(
    port,
    `/approvals/proposal/${nativeConfig.proposal.id}/decision`,
    'POST',
    {
      decision: 'approve_apply',
      revision: nativeConfig.proposal.revision,
      target_hash: nativeConfig.proposal.target_hash,
      adapter: 'test',
      test_managed_missing: true
    },
    409,
    'managed_cc_switch_install_required'
  );
  const nativeActivated = await api(port, `/approvals/proposal/${nativeConfig.proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: nativeConfig.proposal.revision,
    target_hash: nativeConfig.proposal.target_hash,
    adapter: 'test',
    test_managed_missing: true,
    native_fallback: true
  });
  assert.equal(nativeActivated.revision.reconciliation.mode, 'native-fallback');
  const privateTmp = path.join(fixture.home, 'cc-switch-managed', 'private-tmp');
  assert.equal(fs.existsSync(privateTmp) ? fs.readdirSync(privateTmp).length : 0, 0);
  assert.equal(sha256(realCcSwitchFixture), ccSwitchHash);
  console.log('V1.3 governance integration tests passed');
} finally {
  await server?.stop();
  await stateApi?.checkpointAndCloseState().catch(() => undefined);
  cleanup(fixture.root);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
