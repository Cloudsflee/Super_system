import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-mcp-auth-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const migration = await import('../../apps/api/src/state-migration-v17.mjs');
  const clients = await import('../../apps/api/src/mcp-client-service.mjs');
  const vault = await import('../../apps/api/src/vault.mjs');
  await stateApi.ensureRuntime();
  await stateApi.mutate((state) => {
    state.projects.push({
      id: 'project-v18-auth',
      title: 'MCP auth',
      status: 'active',
      settings: {},
      lifecycle_operation: null
    });
  });

  const created = await clients.createMcpClient(
    {
      name: 'Operator',
      scopes: ['system:read', 'project:read'],
      project_allowlist: ['project-v18-auth'],
      ttl_seconds: 3600,
      concurrent_limit: 2,
      rate_limit_per_minute: 20
    },
    'owner-test'
  );
  assert.match(created.token, /^aiws_mcp_/);
  assert.equal(Object.hasOwn(created.client, 'token_hash'), false);
  assert.equal(created.client.subject_user_id, null);
  const stored = (await stateApi.readState()).mcp_clients[0];
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(stored).includes(created.token), false);
  assert.equal(Object.hasOwn(stored, 'token'), false);
  vault.rememberSecret('short-regression', 'client');
  const redacted = JSON.parse(
    vault.redactKnownSecretsSync('{"mcp_clients":[],"client_id":"client","message":"client failed"}')
  );
  assert.deepEqual(redacted.mcp_clients, []);
  assert.equal(redacted.client_id, '***MASKED***');
  assert.equal(redacted.message, '***MASKED*** failed');

  const authenticated = await clients.authenticateMcpToken(created.token, {
    requiredScopes: ['system:read'],
    projectId: 'project-v18-auth'
  });
  assert.equal(authenticated.id, created.client.id);
  const owner = (await stateApi.readState()).users[0];
  const userBound = await clients.createMcpClient(
    { name: 'Owner Codex', subject_user_id: owner.id, scopes: ['system:read'], ttl_seconds: 3600 },
    owner.id
  );
  assert.equal((await clients.authenticateMcpToken(userBound.token)).subject_user_id, owner.id);
  await assert.rejects(
    () =>
      clients.createMcpClient(
        { name: 'Missing member', subject_user_id: 'usr_missing', scopes: ['system:read'] },
        owner.id
      ),
    (error) => error.status === 400 && error.payload.error === 'mcp_client_subject_user_not_found'
  );
  await assert.rejects(
    () => clients.authenticateMcpToken(`${created.token}x`),
    (error) => error.status === 401 && error.payload.error === 'mcp_token_invalid'
  );
  await assert.rejects(
    () => clients.authenticateMcpToken(created.token, { requiredScopes: ['project:write'] }),
    (error) => error.status === 403 && error.payload.error === 'mcp_scope_required'
  );
  await assert.rejects(
    () => clients.authenticateMcpToken(created.token, { projectId: 'project-other' }),
    (error) => error.status === 403 && error.payload.error === 'mcp_project_access_denied'
  );

  const member = {
    id: 'usr_auth_member',
    display_name: 'Auth Member',
    role: 'member',
    auth_mode: 'test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await stateApi.mutate((state) => {
    state.users.push(member);
  });
  const previousRemoteMode = process.env.AIWS_MCP_REMOTE_MODE;
  process.env.AIWS_MCP_REMOTE_MODE = 'gateway';
  try {
    await assert.rejects(
      () =>
        clients.createMcpClient(
          { name: 'Unscoped member', subject_user_id: member.id, scopes: ['project:read'] },
          owner.id
        ),
      (error) => error.status === 400 && error.payload.error === 'mcp_client_project_allowlist_required'
    );
    await assert.rejects(
      () =>
        clients.createMcpClient(
          {
            name: 'Member admin',
            subject_user_id: member.id,
            scopes: ['mcp:admin'],
            project_allowlist: ['project-v18-auth']
          },
          owner.id
        ),
      (error) => error.status === 403 && error.payload.error === 'mcp_client_subject_role_forbidden'
    );
    await assert.rejects(
      () =>
        clients.createMcpClient(
          {
            name: 'Member approver',
            subject_user_id: member.id,
            scopes: ['approval:decide'],
            project_allowlist: ['project-v18-auth']
          },
          owner.id
        ),
      (error) => error.status === 403 && error.payload.error === 'mcp_client_approver_role_required'
    );
    const memberClient = await clients.createMcpClient(
      {
        name: 'Scoped member',
        subject_user_id: member.id,
        scopes: ['project:read'],
        project_allowlist: ['project-v18-auth']
      },
      owner.id
    );
    assert.equal(memberClient.client.subject_user_id, member.id);
  } finally {
    if (previousRemoteMode === undefined) delete process.env.AIWS_MCP_REMOTE_MODE;
    else process.env.AIWS_MCP_REMOTE_MODE = previousRemoteMode;
  }

  const v17 = await stateApi.readState(),
    v16 = structuredClone(v17);
  v16.schema_version = 16;
  delete v16.mcp_clients;
  const migrated = migration.migrateState16To17(v16, { timestamp: '2026-07-17T00:00:00.000Z' });
  assert.equal(migrated.state.schema_version, 17);
  assert.deepEqual(migrated.state.mcp_clients, []);
  assert.equal(migration.migrateState16To17(migrated.state).migrated, false);
  const invalid = structuredClone(await stateApi.readState());
  invalid.schema_version = 17;
  invalid.mcp_clients[0].token = created.token;
  assert.throws(() => migration.validateState17(invalid), /mcp_client_plaintext_token_forbidden/);

  const file = path.join(root, 'state.json'),
    original = `${JSON.stringify(v16, null, 2)}\n`;
  fs.writeFileSync(file, original);
  await assert.rejects(
    () =>
      migration.migrateStateFileToV17(file, {
        backupDirectory: path.join(root, 'migrations'),
        clock: () => new Date('2026-07-17T01:02:03.000Z'),
        afterReplace: () => {
          const error = new Error('rollback-probe');
          error.code = 'rollback_probe';
          throw error;
        }
      }),
    /rollback-probe/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  await clients.revokeMcpClient(created.client.id, 'owner-test');
  await assert.rejects(
    () => clients.authenticateMcpToken(created.token),
    (error) => error.status === 401 && error.payload.error === 'mcp_client_revoked'
  );
  console.log('V1.8 MCP auth and schema unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
