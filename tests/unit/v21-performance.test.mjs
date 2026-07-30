import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { finalizeWorkflowOutcomesInState } from '../../apps/api/src/outcome-service.mjs';
import { emptyState } from '../../apps/api/src/state.mjs';
import {
  CONTEXT_SELECTION_SCHEMA,
  compactContextMap,
  contextHash,
  createContextSearchIndex,
  createContextSelection,
  ensureContextCollections,
  searchContextSearchIndex
} from '../../packages/system-context/src/index.mjs';

const nodeCount = 10_000,
  projectId = 'project-performance',
  state = ensureContextCollections({}),
  projectNode = contextNode('project-node', null, 'project', '性能项目');
state.context_nodes.push(projectNode);
for (let index = 0; index < nodeCount - 1; index += 1) {
  const value = contextNode(`node-${String(index).padStart(5, '0')}`, projectNode.id, 'record', `上下文节点 ${index}`),
    version = {
      id: `version-${index}`,
      node_id: value.id,
      source_hash: value.source_hash,
      content_sha256: contextHash(`document-${index}`),
      token_estimate: 10
    };
  value.current_version_id = version.id;
  state.context_nodes.push(value);
  state.context_document_versions.push(version);
}

compactContextMap(state.context_nodes, { rootId: projectNode.id, maxDepth: 2, maxNodes: nodeCount });
const mapP95 = timedP95(12, () =>
  compactContextMap(state.context_nodes, { rootId: projectNode.id, maxDepth: 2, maxNodes: nodeCount })
);
assert.ok(mapP95 <= 150, `cached map p95 ${mapP95.toFixed(2)}ms exceeds 150ms`);

const searchIndex = createContextSearchIndex(
  state.context_nodes.map((item) => ({
    id: item.id,
    node_id: item.id,
    title: item.title,
    path: item.title,
    summary: item.deterministic_summary,
    facts: `${item.title} 确定性事实 searchable context`
  }))
);
searchContextSearchIndex(searchIndex, '上下文 4321');
const searchP95 = timedP95(30, () => searchContextSearchIndex(searchIndex, '上下文 4321'));
assert.ok(searchP95 <= 250, `full-text search p95 ${searchP95.toFixed(2)}ms exceeds 250ms`);

const candidates = state.context_nodes.slice(1, 201).map((item) => item.id),
  mandatoryEvidenceNodeIds = candidates.slice(0, 20);
createSelection('selection-warmup');
let sequence = 0;
const selectionP95 = timedP95(20, () => createSelection(`selection-${sequence++}`));
assert.ok(selectionP95 <= 500, `Selection v2 p95 ${selectionP95.toFixed(2)}ms exceeds 500ms`);

const finalizationState = outcomeFixture(200);
finalizeWorkflowOutcomesInState(finalizationState, 'wex-warmup', {
  timestamp: '2026-07-30T00:00:00.000Z'
});
const finalizationP95 = timedP95(10, () => {
  const fixture = outcomeFixture(200, `run-${sequence++}`);
  finalizeWorkflowOutcomesInState(fixture, fixture.workflow_executions[0].id, {
    timestamp: '2026-07-30T00:00:00.000Z'
  });
  assert.equal(fixture.workflow_executions[0].release_eligible, true);
});
assert.ok(finalizationP95 <= 5_000, `200-node finalization p95 ${finalizationP95.toFixed(2)}ms exceeds 5000ms`);

console.log(
  `V2.1 10k Context/200-node finalization performance passed ` +
    `(map p95=${mapP95.toFixed(2)}ms, search p95=${searchP95.toFixed(2)}ms, ` +
    `selection p95=${selectionP95.toFixed(2)}ms, finalization p95=${finalizationP95.toFixed(2)}ms)`
);

function createSelection(id) {
  const selection = createContextSelection(state, {
    id,
    actorId: 'owner',
    projectId,
    candidateNodeIds: candidates,
    mandatoryEvidenceNodeIds,
    tokenBudget: 4_000,
    allowedProjectIds: [projectId],
    rubricHash: 'a'.repeat(64),
    outcomeContractHash: 'b'.repeat(64),
    schemaVersion: CONTEXT_SELECTION_SCHEMA
  });
  assert.equal(selection.mandatory_evidence.missing_node_ids.length, 0);
  return selection;
}

function contextNode(id, parentId, kind, title) {
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    kind,
    title,
    deterministic_summary: `${title} 摘要`,
    project_id: projectId,
    parent_id: parentId,
    status: 'active',
    sensitivity: 'internal',
    authority: 'authoritative',
    freshness: { status: 'current' },
    required_scopes: ['context:read', 'project:read'],
    source_hash: contextHash({ id }),
    current_version_id: null,
    sort: { type_order: kind === 'project' ? 10 : 120, order_index: 0, stable_id: id }
  };
}

function outcomeFixture(count, suffix = 'warmup') {
  const value = emptyState(),
    executionId = suffix === 'warmup' ? 'wex-warmup' : `wex-${suffix}`,
    timestamp = '2026-07-30T00:00:00.000Z';
  value.schema_version = 21;
  value.workflow_executions.push({
    id: executionId,
    project_id: 'project-finalization',
    workflow_id: 'workflow-finalization',
    status: 'running',
    completion_status: 'pending',
    release_eligible: false,
    finalization_state: 'evaluating',
    outcome_summary: summary(count),
    outcome_facts: {},
    created_at: timestamp,
    updated_at: timestamp
  });
  for (let index = 0; index < count; index += 1) {
    const requirementId = `requirement-${suffix}-${index}`,
      contractRequirementId = `task-${index}`;
    value.task_executions.push({
      id: `task-execution-${suffix}-${index}`,
      workflow_execution_id: executionId,
      task_id: contractRequirementId,
      status: 'completed',
      completed_at: timestamp,
      updated_at: timestamp
    });
    value.outcome_requirements.push({
      id: requirementId,
      workflow_execution_id: executionId,
      project_id: 'project-finalization',
      contract_requirement_id: contractRequirementId,
      source: 'outcome_contract',
      contract_version: 1,
      contract_hash: 'c'.repeat(64),
      rubric_hash: null,
      title: contractRequirementId,
      description: null,
      mandatory: true,
      scope: 'task',
      task_id: contractRequirementId,
      order: index,
      evaluator: 'task_acceptance',
      expected: { completed: true },
      waivable: true,
      evaluator_config: {},
      immutable: true,
      created_at: timestamp
    });
    value.workflow_executions[0].outcome_facts[contractRequirementId] = {
      status: 'satisfied',
      actual: { completed: true },
      evidence_refs: [`task_execution:task-execution-${suffix}-${index}`]
    };
  }
  return value;
}

function summary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}

function timedP95(iterations, action) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    action();
    values.push(performance.now() - started);
  }
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * 0.95) - 1];
}
