import assert from 'node:assert/strict';

import { applicationAdditionalContext, createTurnContext } from '../../apps/api/src/assist-v3-context.mjs';
import {
  CONTEXT_PACK_SCHEMA,
  contextHash,
  ensureContextCollections
} from '../../packages/system-context/src/index.mjs';

const project = {
  id: 'project-v20-pack',
  title: 'V2 Context Pack',
  goal: '只发送低成本地图',
  status: 'draft',
  settings: { token_budget: 8000 }
};
const session = {
  id: 'assist-v20-pack',
  project_id: project.id,
  workspace_id: 'workspace-v20-pack',
  scope_type: 'project',
  scope_id: project.id,
  scope_snapshot: { title: project.title },
  clarification_policy: 'ask',
  native_thread_generation: 2
};
const turn = {
  id: 'turn-v20-pack',
  mode: 'default',
  prompt: '读取当前上下文',
  repository_workspace_id: null,
  operation_reference_id: null,
  code_access: 'read_only',
  code_read_only_reason: 'test',
  view_context: { route: `/projects/${project.id}` }
};
const state = ensureContextCollections({
  projects: [project],
  repository_workspaces: [],
  assets: [],
  workflow_nodes: [],
  workflows: [],
  workflow_drafts: [],
  decisions: [],
  assist_operations: [],
  change_proposals: [],
  project_briefs: [
    {
      id: 'brief-v20-pack',
      project_id: project.id,
      status: 'confirmed',
      version: 1,
      revision: 1,
      content: { private_large_fact: 'FULL_PROJECT_FACT_MUST_NOT_BE_PRELOADED' }
    }
  ]
});
const projectNode = {
  id: 'context-project-v20-pack',
  uri: 'aiws://context/nodes/context-project-v20-pack',
  kind: 'project',
  source_collection: 'projects',
  source_id: project.id,
  project_id: project.id,
  parent_id: null,
  title: project.title,
  deterministic_summary: project.goal,
  status: 'active',
  sensitivity: 'internal',
  authority: 'authoritative',
  freshness: { status: 'current' },
  required_scopes: ['context:read', 'project:read'],
  source_hash: contextHash(project),
  sort: { type_order: 10, order_index: 0, stable_id: project.id }
};
const document = {
  id: 'context-version-v20-pack',
  node_id: projectNode.id,
  source_hash: projectNode.source_hash,
  content_sha256: contextHash('project context'),
  token_estimate: 50
};
projectNode.current_version_id = document.id;
state.context_nodes.push(projectNode);
state.context_document_versions.push(document);

const { check, pack } = createTurnContext(state, {
  actor: { id: 'owner-v20-pack' },
  project,
  session,
  turn,
  attachmentIds: []
});
assert.equal(check.status, 'sufficient');
assert.equal(pack.schema_version, CONTEXT_PACK_SCHEMA);
assert.equal(pack.version, 4);
assert.equal(pack.content_json.schema_version, CONTEXT_PACK_SCHEMA);
assert.equal(pack.context_selection_id, pack.content_json.context_selection_id);
assert.deepEqual(pack.context_document_versions, [document.id]);
assert.deepEqual(pack.content_json.document_versions, [
  {
    node_id: projectNode.id,
    document_version_id: document.id,
    content_sha256: document.content_sha256
  }
]);
assert.equal(state.context_selections.length, 1);
assert.equal(state.context_selections[0].immutable, true);

const additional = JSON.parse(
  applicationAdditionalContext({ turn, session, project, contextPack: pack, attachments: [] })[0].value
);
assert.equal(additional.context_pack.schema_version, CONTEXT_PACK_SCHEMA);
assert.equal(additional.context_pack.context_selection_id, pack.context_selection_id);
assert.ok(additional.context_pack.context_map.markdown.includes(project.title));
assert.equal(JSON.stringify(additional).includes('FULL_PROJECT_FACT_MUST_NOT_BE_PRELOADED'), false);
assert.equal(Object.hasOwn(additional.context_pack, 'brief'), false);

const legacy = { schema_version: 'aiws.context_pack.v3', content_json: { legacy: true, exact: 'read-only' } };
const legacyAdditional = JSON.parse(
  applicationAdditionalContext({ turn, session, project, contextPack: legacy, attachments: [] })[0].value
);
assert.deepEqual(legacyAdditional.context_pack, legacy.content_json);

console.log('V2.0 Context Pack v4 and legacy read-only compatibility tests passed');
