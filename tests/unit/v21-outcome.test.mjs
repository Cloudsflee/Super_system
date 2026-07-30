import assert from 'node:assert/strict';

import { protocolHash } from '../../packages/execution-protocol/src/index.mjs';
import { emptyState } from '../../apps/api/src/state.mjs';
import {
  createOutcomeWaiverInState,
  evaluateWorkflowOutcomesInState,
  materializeOutcomeRequirementsInState,
  revokeOutcomeWaiverInState
} from '../../apps/api/src/outcome-service.mjs';
import {
  assertV21AppendOnly,
  normalizeState21Defaults,
  validateState21
} from '../../apps/api/src/state-migration-v21.mjs';

const T0 = '2026-07-30T00:00:00.000Z';
const state = fixture();
const execution = state.workflow_executions[0];
materializeOutcomeRequirementsInState(state, execution, state.workflows[0], T0);

const first = evaluateWorkflowOutcomesInState(state, execution.id, { timestamp: T0 });
assert.equal(first.workflow_execution.completion_status, 'completed_with_gaps');
assert.equal(first.workflow_execution.release_eligible, false);
assert.equal(first.workflow_execution.outcome_summary.mandatory_gaps, 3);
assert.equal(first.workflow_execution.outcome_summary.optional_gaps, 1);

const gapIds = first.requirements
  .filter(
    (item) =>
      item.mandatory &&
      first.evaluations.find((evaluation) => evaluation.requirement_id === item.id)?.status !== 'satisfied'
  )
  .map((item) => item.id);
const nonWaivable = first.requirements.find((item) => item.contract_requirement_id === 'context_freshness');
assert.throws(
  () =>
    createOutcomeWaiverInState(
      state,
      execution.id,
      {
        requirement_ids: [nonWaivable.id],
        reason: 'Context freshness cannot be waived.',
        evidence_refs: ['fixture:context'],
        expires_at: '2026-08-01T00:00:00.000Z'
      },
      'owner',
      { timestamp: T0 }
    ),
  (error) => error.payload?.error === 'outcome_requirement_nonwaivable'
);
assert.throws(
  () =>
    createOutcomeWaiverInState(
      state,
      execution.id,
      {
        requirement_ids: gapIds,
        reason: 'Collaborator cannot authorize a release waiver.',
        evidence_refs: ['fixture:unauthorized'],
        expires_at: '2026-08-01T00:00:00.000Z'
      },
      'collaborator',
      { timestamp: T0 }
    ),
  (error) => error.payload?.error === 'outcome_waiver_owner_required'
);

const immutableBefore = snapshotImmutable(state);
const waiver = createOutcomeWaiverInState(
  state,
  execution.id,
  {
    requirement_ids: gapIds,
    reason: 'Owner accepts the fixed DesignSignal regression gaps.',
    evidence_refs: ['fixture:designsignal-5-of-6', 'fixture:designsignal-12-of-15', 'fixture:outbox-pending'],
    expires_at: '2026-08-06T00:00:00.000Z'
  },
  'owner',
  { timestamp: T0 }
);
assert.equal(execution.completion_status, 'waived');
assert.equal(execution.release_eligible, true);
assertV21AppendOnly(immutableBefore, state);

revokeOutcomeWaiverInState(state, execution.id, waiver.id, { reason: 'Fixture evidence was superseded.' }, 'owner', {
  timestamp: '2026-07-31T00:00:00.000Z'
});
assert.equal(execution.completion_status, 'completed_with_gaps');
assert.equal(execution.release_eligible, false);

execution.outcome_facts = Object.fromEntries(
  ['source_coverage', 'authority_coverage', 'delivery_receipt', 'context_freshness', 'optional_depth'].map((id) => [
    id,
    { status: 'satisfied', actual: { passed: true }, evidence_refs: [`fixture:${id}`] }
  ])
);
evaluateWorkflowOutcomesInState(state, execution.id, { timestamp: '2026-08-01T00:00:00.000Z' });
assert.equal(execution.completion_status, 'completed');
assert.equal(execution.release_eligible, true);
normalizeState21Defaults(state, '2026-08-01T00:00:00.000Z');
validateState21(state);

const tampered = structuredClone(state);
tampered.outcome_evaluations[0].reason_code = 'changed';
assert.throws(
  () => assertV21AppendOnly(snapshotImmutable(state), tampered),
  (error) => error.code === 'v21_immutable_record_changed'
);

console.log('V2.1 Outcome, DesignSignal fixture, waiver, permission and immutability tests passed');

function fixture() {
  const value = emptyState();
  value.schema_version = 21;
  value.instance_owner_user_id = 'owner';
  value.users.push(
    { id: 'owner', role: 'owner', auth_mode: 'test' },
    { id: 'collaborator', role: 'collaborator', auth_mode: 'test' }
  );
  value.projects.push({
    id: 'project',
    title: 'DesignSignal fixture',
    status: 'active',
    owner_user_id: 'owner',
    lifecycle_operation: null
  });
  value.project_memberships.push(
    { id: 'pm-owner', project_id: 'project', user_id: 'owner', role: 'owner', status: 'active' },
    { id: 'pm-collaborator', project_id: 'project', user_id: 'collaborator', role: 'collaborator', status: 'active' }
  );
  const outcomeContract = {
    schema_version: 'aiws.outcome_contract.v1',
    version: 1,
    source: 'declared',
    requirements: [
      requirement('source_coverage', '5/6 source coverage', true, 'metric', 'trusted_metric', true, 0),
      requirement('authority_coverage', '12/15 authority coverage', true, 'content', 'claim_coverage', true, 1),
      requirement('delivery_receipt', 'Outbox delivery receipt', true, 'delivery', 'delivery_receipt', true, 2),
      requirement('context_freshness', 'Context freshness', true, 'context', 'context_freshness', false, 3),
      requirement('optional_depth', 'Optional depth', false, 'content', 'evidence_refs', true, 4)
    ]
  };
  const qualityRubric = {
    schema_version: 'aiws.quality_rubric.v1',
    version: 1,
    criteria: [
      {
        id: 'non_content_not_applicable',
        title: 'Fixture rubric declared not applicable',
        evaluator: 'evidence_refs',
        mandatory: false,
        applicable: false,
        expected: null,
        authority_mapping: {}
      }
    ]
  };
  value.workflows.push({
    id: 'workflow',
    project_id: 'project',
    title: 'DesignSignal',
    status: 'active',
    version: 1,
    workflow_revision: 1,
    outcome_contract: outcomeContract,
    quality_rubric: qualityRubric,
    outcome_contract_hash: protocolHash(outcomeContract),
    quality_rubric_hash: protocolHash(qualityRubric)
  });
  value.workflow_executions.push({
    id: 'wex',
    project_id: 'project',
    workflow_id: 'workflow',
    workflow_revision: 1,
    status: 'running',
    completion_status: 'pending',
    release_eligible: false,
    finalization_state: 'pending',
    outcome_summary: summary(0),
    outcome_facts: {
      source_coverage: {
        status: 'unsatisfied',
        actual: { covered: 5, total: 6 },
        evidence_refs: ['fixture:designsignal-5-of-6']
      },
      authority_coverage: {
        status: 'unsatisfied',
        actual: { covered: 12, total: 15 },
        evidence_refs: ['fixture:designsignal-12-of-15']
      },
      delivery_receipt: {
        status: 'unsatisfied',
        actual: { status: 'pending' },
        evidence_refs: ['fixture:outbox-pending']
      },
      context_freshness: { status: 'satisfied', actual: { current: true }, evidence_refs: ['fixture:context'] },
      optional_depth: { status: 'unsatisfied', actual: { depth: 'shallow' }, evidence_refs: ['fixture:depth'] }
    },
    frontier: [],
    waiting_reasons: [],
    started_at: T0,
    created_at: T0,
    updated_at: T0
  });
  normalizeState21Defaults(value, T0);
  return value;
}

function requirement(id, title, mandatory, scope, evaluator, waivable, order) {
  return { id, title, mandatory, scope, order, evaluator, expected: { passed: true }, waivable, evaluator_config: {} };
}

function summary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}

function snapshotImmutable(value) {
  return Object.fromEntries(
    ['outcome_requirements', 'outcome_evaluations', 'outcome_waivers', 'execution_stage_checkpoints'].map((key) => [
      key,
      structuredClone(value[key])
    ])
  );
}
