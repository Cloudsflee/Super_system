import assert from 'node:assert/strict';
import { createMcpTestFixture, waitFor } from '../v18/mcp-test-helpers.mjs';

let fixture;
try {
  fixture = await createMcpTestFixture('aiws-v19-assist-recovery-acl-', {
    seed: async ({ stateApi }) =>
      stateApi.mutate((state) => {
        const owner = state.users.find((item) => item.id === state.instance_owner_user_id),
          at = new Date().toISOString();
        state.users.push({
          id: 'recovery-collaborator',
          display_name: 'Recovery collaborator',
          role: 'member',
          auth_mode: 'test',
          created_at: at,
          updated_at: at
        });
        state.projects.push({
          id: 'recovery-project',
          title: 'Recovery Project',
          goal: 'Keep actor authority',
          owner_user_id: owner.id,
          created_by_user_id: owner.id,
          status: 'active',
          onboarding_state: 'confirmed',
          deleted_at: null,
          settings: {},
          created_at: at,
          updated_at: at
        });
        state.project_memberships.push({
          id: 'recovery-membership',
          project_id: 'recovery-project',
          user_id: 'recovery-collaborator',
          role: 'collaborator',
          status: 'revoked',
          revoked_at: at,
          created_at: at,
          updated_at: at
        });
        state.assist_sessions.push({
          id: 'recovery-session',
          version: 3,
          project_id: 'recovery-project',
          scope_type: 'project',
          scope_id: 'recovery-project',
          title: 'Queued recovery',
          status: 'idle',
          lifecycle: 'active',
          archived_at: null,
          deleted_at: null,
          created_by_user_id: 'recovery-collaborator',
          created_at: at,
          updated_at: at
        });
        state.assist_turns.push({
          id: 'recovery-turn',
          session_id: 'recovery-session',
          project_id: 'recovery-project',
          mode: 'default',
          collaboration_mode: 'default',
          prompt: 'Must not execute after access revocation',
          status: 'queued',
          test_adapter: true,
          test_response: { message: 'incorrectly executed' },
          code_access: 'read_only',
          attachment_ids: [],
          created_by_user_id: 'recovery-collaborator',
          created_at: at,
          updated_at: at
        });
      })
  });
  const turn = await waitFor(
    async () => {
      const current = (await fixture.stateApi.readState()).assist_turns.find((item) => item.id === 'recovery-turn');
      return current?.status === 'failed' ? current : null;
    },
    { message: 'revoked queued Assist turn was not rejected during recovery' }
  );
  assert.equal(turn.error_code, 'project_access_denied');
  assert.equal(
    (await fixture.stateApi.readState()).assist_messages.some(
      (item) => item.turn_id === turn.id && item.role === 'assistant'
    ),
    false
  );
  console.log('V1.9 queued Assist recovery actor ACL flow passed');
} finally {
  await fixture?.close();
}
