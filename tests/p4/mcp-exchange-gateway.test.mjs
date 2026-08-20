import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadCleanConfig } from '../../apps/api/src/clean/config.mjs';
import { createGatewayServer } from '../../apps/gateway/server.mjs';
import { close, open, project } from './helpers.mjs';

test('production startup requires explicit MCP pepper and Gateway secret', () => {
  assert.throws(() => loadCleanConfig({ NODE_ENV: 'production' }), /mcp_pepper_required/);
  assert.throws(() => loadCleanConfig({ NODE_ENV: 'production', AIWS_CLEAN_MCP_PEPPER: 'm'.repeat(32) }), /gateway_secret_required/);
  const config = loadCleanConfig({ NODE_ENV: 'production', AIWS_CLEAN_MCP_PEPPER: 'm'.repeat(32), AIWS_GATEWAY_SECRET: 'g'.repeat(32) });
  assert.equal(config.gatewaySecret.length, 32);
  assert.throws(() => createGatewayServer({ nodeEnv: 'production', secret: '' }), /gateway_secret_required/);
});

test('MCP client tokens are one-time, HMAC-only and constrained by project and tool allowlists', async () => {
  const state = await open();
  try {
    const first = await project(state, 'mcp-first');
    const second = await project(state, 'mcp-second');
    await state.runtime.context.createSource(first.id, { kind: 'note', title: 'MCP note', uri: 'notes/mcp', content: 'transport parity', idempotency_key: 'p4-mcp-source-key' }, state.principal);
    await state.runtime.context.rebuild(first.id, { idempotency_key: 'p4-mcp-rebuild-key' }, state.principal);
    const input = {
      name: 'P4 client', transport: 'stdio', ttl_seconds: 3600,
      scope: { project_ids: [first.id], tools: ['context_map', 'context_search'] },
      idempotency_key: 'p4-mcp-client-key'
    };
    const created = await state.runtime.mcp.createClient(input, state.principal);
    assert.match(created.token, /^aiws_mcp_[A-Za-z0-9_-]{40,}$/);
    const replay = await state.runtime.mcp.createClient(input, state.principal);
    assert.equal(replay.client.id, created.client.id);
    assert.equal(replay.replayed, true);
    assert.equal(Object.hasOwn(replay, 'token'), false);
    const stored = state.runtime.db.get('SELECT * FROM mcp_clients WHERE id=?', [created.client.id]);
    assert.equal(JSON.stringify(stored).includes(created.token), false);
    assert.equal(stored.token_hmac.length, 64);

    const auth = state.runtime.mcp.authenticate(created.token, { projectId: first.id, tool: 'context_map' });
    assert.equal(auth.client.id, created.client.id);
    assert.throws(() => state.runtime.mcp.authenticate(created.token, { projectId: second.id, tool: 'context_map' }), (error) => error.code === 'mcp_scope_denied');
    assert.throws(() => state.runtime.mcp.authenticate(created.token, { projectId: first.id, tool: 'context_read' }), (error) => error.code === 'mcp_scope_denied');
    const principal = { actorId: auth.actor_id, effectiveActorId: auth.actor_id, scopes: ['*'], projectId: first.id, mcpClientId: auth.client.id };
    const result = await state.runtime.mcp.dispatch('context_map', { project_id: first.id }, principal);
    assert.equal(result.command_id, 'context.map');
    assert.equal(result.result.nodes.length, 2);

    const revoked = await state.runtime.mcp.revokeClient(created.client.id, { expected_revision: 1, idempotency_key: 'p4-mcp-revoke-key' }, state.principal);
    assert.equal(revoked.client.status, 'revoked');
    assert.throws(() => state.runtime.mcp.authenticate(created.token, { projectId: first.id, tool: 'context_map' }), (error) => error.code === 'mcp_token_expired');
  } finally { await close(state); }
});

test('Exchange requires both approvals, creates a narrowing grant and rechecks revoke immediately', async () => {
  const state = await open();
  try {
    const source = await project(state, 'exchange-source');
    const target = await project(state, 'exchange-target');
    await state.runtime.context.createSource(source.id, { kind: 'note', title: 'Exchange note', uri: 'notes/exchange', content: 'grant evidence', idempotency_key: 'p4-exchange-source-key' }, state.principal);
    await state.runtime.context.rebuild(source.id, { idempotency_key: 'p4-exchange-rebuild-key' }, state.principal);
    const selection = await state.runtime.context.createSelection(source.id, { token_budget: 256, idempotency_key: 'p4-exchange-selection-key' }, state.principal);
    const request = await state.runtime.mcp.createExchangeRequest({
      source_project_id: source.id, target_project_id: target.id, ttl_seconds: 3600,
      scope: { project_ids: [source.id], tools: ['context_pack_get'], actions: ['read'], resources: ['context'] },
      idempotency_key: 'p4-exchange-request-key'
    }, state.principal);
    assert.equal(request.request.status, 'requested');
    const sourceApproval = await state.runtime.mcp.approveExchange(request.request.id, {
      side: 'source', expected_revision: 1, idempotency_key: 'p4-exchange-source-approval'
    }, state.principal);
    assert.equal(sourceApproval.request.status, 'partially_approved');
    assert.equal(sourceApproval.grant, null);
    const targetApproval = await state.runtime.mcp.approveExchange(request.request.id, {
      side: 'target', expected_revision: 2, idempotency_key: 'p4-exchange-target-approval'
    }, state.principal);
    assert.equal(targetApproval.request.status, 'active');
    assert.equal(targetApproval.grant.status, 'active');
    const pack = await state.runtime.mcp.createGrantPack(targetApproval.grant.id, {
      selection_id: selection.selection.id, require_authoritative: false, idempotency_key: 'p4-exchange-pack-key'
    }, state.principal);
    assert.equal(pack.pack.schema_version, 'aiws.context_pack.v5');
    const revoked = await state.runtime.mcp.revokeGrant(targetApproval.grant.id, {
      expected_revision: 1, idempotency_key: 'p4-exchange-revoke-key'
    }, state.principal);
    assert.equal(revoked.grant.status, 'revoked');
    await assert.rejects(() => state.runtime.mcp.createGrantPack(targetApproval.grant.id, {
      selection_id: selection.selection.id, require_authoritative: false, idempotency_key: 'p4-exchange-pack-revoked'
    }, state.principal), (error) => error.code === 'exchange_grant_expired');
  } finally { await close(state); }
});

test('Gateway verifies canonical signatures, blocks replay and stores only hashes and decisions', async () => {
  const state = await open();
  try {
    const current = await project(state, 'gateway');
    const body = { name: 'context_map', arguments: { project_id: current.id } };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'p4-gateway-nonce-first';
    const headers = {
      'X-AIWS-Gateway-Id': 'gateway-probe',
      'X-AIWS-Gateway-Timestamp': timestamp,
      'X-AIWS-Gateway-Nonce': nonce,
      'X-AIWS-Gateway-Signature': state.runtime.gateway.sign({ timestamp, nonce, body })
    };
    const accepted = await state.runtime.gateway.forward({
      headers, body,
      dispatch: async () => state.runtime.dispatcher.dispatch('context_map', { project_id: current.id }, state.principal)
    });
    assert.equal(accepted.receipt.decision, 'accepted');
    assert.equal(accepted.result.command_id, 'context.map');
    const stored = state.runtime.db.get('SELECT * FROM gateway_forward_receipts WHERE id=?', [accepted.receipt.id]);
    assert.deepEqual(Object.keys(stored).sort(), ['command_id', 'created_at', 'decision', 'gateway_id', 'id', 'nonce_hash', 'operation_id', 'request_hash', 'response_hash']);
    assert.equal(JSON.stringify(stored).includes(current.id), false);
    await assert.rejects(() => state.runtime.gateway.forward({ headers, body, dispatch: async () => ({}) }), (error) => error.code === 'gateway_replay');
    const tampered = { ...body, arguments: { project_id: `${current.id}-tampered` } };
    await assert.rejects(() => state.runtime.gateway.forward({ headers: { ...headers, 'X-AIWS-Gateway-Nonce': 'p4-gateway-nonce-tamper' }, body: tampered, dispatch: async () => ({}) }), (error) => error.code === 'gateway_signature_invalid');

    const processSource = fs.readFileSync(new URL('../../apps/gateway/server.mjs', import.meta.url), 'utf8');
    assert.equal(/node:sqlite|DatabaseSync|CasStore|docker/i.test(processSource), false);
  } finally { await close(state); }
});
