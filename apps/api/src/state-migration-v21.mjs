import { cloneStateValue as structuredClone } from './state-clone.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  COMPLETION_STATUSES,
  EXECUTION_STAGES,
  OUTCOME_CONTRACT_SCHEMA,
  QUALITY_RUBRIC_SCHEMA,
  parseExecutionCheckpoint,
  parseOutcomeContract,
  parseQualityRubric,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import {
  CONTEXT_INTERNAL_COLLECTIONS,
  reconcileContextProjectionState,
  validateContextState
} from '../../../packages/system-context/src/index.mjs';
import { collections as ALL_STATE_COLLECTIONS } from './config.mjs';
import {
  canonicalStateHash,
  migrateState19To20,
  normalizeState20Defaults,
  sha256,
  validateState20
} from './state-migration-v20.mjs';
export { normalizeOutcomeEvidenceRelationsV20, normalizeTaskHandoffDefaultsV20 } from './state-migration-v20.mjs';

export const STATE_SCHEMA_VERSION = 21;
export const V21_OUTCOME_COLLECTIONS = Object.freeze([
  'outcome_requirements',
  'outcome_evaluations',
  'outcome_waivers',
  'execution_stage_checkpoints'
]);
export const V21_SOURCE_COLLECTIONS = Object.freeze(
  ALL_STATE_COLLECTIONS.filter(
    (collection) =>
      !CONTEXT_INTERNAL_COLLECTIONS.includes(collection) &&
      !['quality_review_runs', 'quality_review_reports', 'quality_review_events'].includes(collection)
  )
);
export const V21_COLLECTIONS = Object.freeze([...V21_SOURCE_COLLECTIONS, ...CONTEXT_INTERNAL_COLLECTIONS]);
export const V21_RUNNER_IMAGE = 'aiws-codex-runner:2.1.0-codex-0.144.0';

export { canonicalStateHash, sha256 };

export function migrateState20To21(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion > STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_newer_than_runtime', { schema_version: inputVersion });
  const migrated20 =
    inputVersion === STATE_SCHEMA_VERSION
      ? { state: structuredClone(source), migrated: false, from_version: STATE_SCHEMA_VERSION }
      : migrateState19To20(source, { timestamp });
  const state = migrated20.state;
  normalizeState21Defaults(state, timestamp, { migrating: inputVersion !== STATE_SCHEMA_VERSION });
  state.schema_version = STATE_SCHEMA_VERSION;
  validateState21(state);
  return {
    state,
    migrated: inputVersion !== STATE_SCHEMA_VERSION,
    from_version: inputVersion,
    to_version: STATE_SCHEMA_VERSION,
    migrated_at: timestamp,
    legacy_unassessed: state.workflow_executions.filter((item) => item.completion_status === 'legacy_unassessed')
      .length,
    active_legacy_derived: state.workflow_executions.filter(
      (item) => item.completion_status === 'pending' && item.outcome_contract_source === 'legacy_derived'
    ).length
  };
}

export function normalizeState21Defaults(state, timestamp = new Date().toISOString(), { migrating = false } = {}) {
  for (const collection of V21_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeState20Defaults(state, timestamp);
  normalizeOfficialRunnerImagesV21(state, { timestamp });
  normalizeLegacyWorkflowDefinitions(state, timestamp, { migrating });
  normalizeWorkflowExecutionCompletion(state, timestamp, { migrating });
  normalizeTaskExecutionStages(state);
  reconcileContextProjectionState(state, { sourceCollections: V21_SOURCE_COLLECTIONS, timestamp });
  if (migrating) state.migrated_to_schema_21_at = timestamp;
  return state;
}

export function normalizeOfficialRunnerImagesV21(state, { timestamp = new Date().toISOString() } = {}) {
  let changed = false;
  const changedProfileIds = new Set();
  const official = /^aiws-codex-runner:(?:1\.(?:[0-9]|10)\.0|2\.[01]\.0)-codex-0\.144\.0$/;
  for (const profile of state.codex_profiles || []) {
    if (official.test(String(profile.image || '')) && profile.image !== V21_RUNNER_IMAGE) {
      profile.image = V21_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      if (profile.id) changedProfileIds.add(profile.id);
      changed = true;
    }
    if (official.test(String(profile.config?.image || '')) && profile.config.image !== V21_RUNNER_IMAGE) {
      profile.config.image = V21_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      if (profile.id) changedProfileIds.add(profile.id);
      changed = true;
    }
  }
  for (const integration of state.integration_statuses || []) {
    if (
      integration.key === 'codex_docker' &&
      official.test(String(integration.image || '')) &&
      integration.image !== V21_RUNNER_IMAGE
    ) {
      integration.image = V21_RUNNER_IMAGE;
      integration.updated_at = timestamp;
      changed = true;
    }
    if (integration.key === 'codex_probe' && changedProfileIds.has(integration.profile_id)) {
      integration.status = 'stale';
      integration.updated_at = timestamp;
      changed = true;
    }
  }
  return { changed, image: V21_RUNNER_IMAGE, profile_ids: [...changedProfileIds].sort() };
}

function normalizeLegacyWorkflowDefinitions(state, timestamp, { migrating }) {
  for (const workflow of state.workflows) {
    if (!workflow.outcome_contract && migrating) workflow.outcome_contract = legacyOutcomeContract(workflow.id);
    if (!workflow.quality_rubric && migrating) workflow.quality_rubric = legacyQualityRubric();
    if (!workflow.outcome_contract || !workflow.quality_rubric) continue;
    workflow.outcome_contract_hash ||= protocolHash(parseOutcomeContract(workflow.outcome_contract));
    workflow.quality_rubric_hash ||= protocolHash(parseQualityRubric(workflow.quality_rubric));
    workflow.protocols ||= {};
    Object.assign(workflow.protocols, {
      outcome_contract: OUTCOME_CONTRACT_SCHEMA,
      quality_rubric: QUALITY_RUBRIC_SCHEMA
    });
    workflow.updated_at ||= timestamp;
  }
}

function normalizeWorkflowExecutionCompletion(state, timestamp, { migrating }) {
  for (const execution of state.workflow_executions) {
    const workflow = state.workflows.find((item) => item.id === execution.workflow_id);
    if (execution.completion_status && !migrating) {
      normalizeCompletionFields(execution);
      continue;
    }
    if (['running', 'paused'].includes(execution.status)) {
      const contract = workflow?.outcome_contract || legacyOutcomeContract(execution.workflow_id);
      execution.completion_status = 'pending';
      execution.release_eligible = false;
      execution.finalization_state ||= 'pending';
      execution.outcome_contract_hash = protocolHash(contract);
      execution.outcome_contract_source = contract.source || 'legacy_derived';
      execution.outcome_summary = emptyOutcomeSummary(contract.requirements.length);
      materializeRequirements(state, execution, contract, timestamp);
    } else {
      execution.completion_status = 'legacy_unassessed';
      execution.release_eligible = false;
      execution.finalization_state = 'legacy';
      execution.outcome_contract_hash ||= null;
      execution.outcome_contract_source ||= null;
      execution.outcome_summary ||= emptyOutcomeSummary(0);
    }
    normalizeCompletionFields(execution);
  }
}

function normalizeCompletionFields(execution) {
  execution.completion_status ||= 'pending';
  execution.release_eligible = execution.release_eligible === true;
  execution.outcome_summary ||= emptyOutcomeSummary(0);
  execution.finalization_state ||= execution.completion_status === 'legacy_unassessed' ? 'legacy' : 'pending';
}

function normalizeTaskExecutionStages(state) {
  for (const execution of state.task_executions) {
    execution.current_stage ||= null;
    execution.stage_checkpoint_ids = uniqueStrings(execution.stage_checkpoint_ids);
    execution.replay_count = Math.max(0, Number(execution.replay_count || 0));
    execution.failure ||= execution.error_code
      ? {
          schema_version: 'aiws.failure_envelope.v1',
          code: String(execution.error_code),
          stage: execution.current_stage || 'execute',
          category: 'runner',
          retryable: execution.retry_class === 'transient',
          message: null,
          field_path: null,
          details: {},
          cause_codes: [],
          occurred_at: execution.completed_at || execution.updated_at || execution.created_at
        }
      : null;
  }
}

function materializeRequirements(state, execution, contract, timestamp) {
  for (const definition of contract.requirements) {
    const requirementId = `oreq_${protocolHash(`${execution.id}:${definition.id}`).slice(0, 24)}`;
    if (state.outcome_requirements.some((item) => item.id === requirementId)) continue;
    state.outcome_requirements.push({
      id: requirementId,
      workflow_execution_id: execution.id,
      project_id: execution.project_id,
      contract_requirement_id: definition.id,
      contract_version: contract.version,
      contract_hash: execution.outcome_contract_hash,
      title: definition.title || definition.id,
      description: definition.description || null,
      mandatory: definition.mandatory,
      scope: definition.scope,
      task_id: definition.task_id || null,
      order: definition.order,
      evaluator: definition.evaluator,
      expected: structuredClone(definition.expected),
      waivable: definition.waivable,
      evaluator_config: structuredClone(definition.evaluator_config || {}),
      immutable: true,
      created_at: timestamp
    });
  }
}

export function legacyOutcomeContract(workflowId = 'legacy') {
  return {
    schema_version: OUTCOME_CONTRACT_SCHEMA,
    version: 1,
    source: 'legacy_derived',
    requirements: [
      {
        id: `legacy_manual_review_${protocolHash(String(workflowId)).slice(0, 12)}`,
        title: '迁移执行人工审阅',
        description: '历史 Workflow 未声明业务 outcome，promotion 前必须由授权 owner 明确审阅。',
        mandatory: true,
        scope: 'manual',
        order: 0,
        evaluator: 'manual_review',
        expected: { approved: true },
        waivable: true,
        evaluator_config: { migration: 'schema20_to_21' }
      }
    ]
  };
}

export function legacyQualityRubric() {
  return {
    schema_version: QUALITY_RUBRIC_SCHEMA,
    version: 1,
    criteria: [
      {
        id: 'legacy_not_applicable',
        title: '历史定义未声明内容质量 rubric',
        evaluator: 'evidence_refs',
        mandatory: false,
        applicable: false,
        expected: null,
        authority_mapping: {}
      }
    ]
  };
}

export function validateState21(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_not_21', { schema_version: state.schema_version ?? null });
  for (const collection of V21_COLLECTIONS)
    if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  validateState20({ ...state, schema_version: 20 });
  validateContextState(state, { sourceCollections: V21_SOURCE_COLLECTIONS });
  validateWorkflowProtocols(state);
  validateOutcomeCollections(state);
  validateStageCheckpoints(state);
  return state;
}

function validateWorkflowProtocols(state) {
  for (const workflow of state.workflows) {
    const hasContract = workflow.outcome_contract != null,
      hasRubric = workflow.quality_rubric != null;
    if (!hasContract && !hasRubric) {
      if (workflow.planning_quality === 'verified')
        throw migrationError('workflow_outcome_protocols_required', { workflow_id: workflow.id });
      continue;
    }
    if (!hasContract || !hasRubric)
      throw migrationError('workflow_outcome_protocol_pair_invalid', { workflow_id: workflow.id });
    const contract = parseOutcomeContract(workflow.outcome_contract);
    const rubric = parseQualityRubric(workflow.quality_rubric);
    if (workflow.outcome_contract_hash !== protocolHash(contract))
      throw migrationError('workflow_outcome_contract_hash_invalid', { workflow_id: workflow.id });
    if (workflow.quality_rubric_hash !== protocolHash(rubric))
      throw migrationError('workflow_quality_rubric_hash_invalid', { workflow_id: workflow.id });
  }
}

function validateOutcomeCollections(state) {
  ensureUniqueIds(state.outcome_requirements, 'outcome_requirements');
  ensureUniqueIds(state.outcome_evaluations, 'outcome_evaluations');
  ensureUniqueIds(state.outcome_waivers, 'outcome_waivers');
  const executions = new Map(state.workflow_executions.map((item) => [item.id, item]));
  const requirements = new Map(state.outcome_requirements.map((item) => [item.id, item]));
  const evaluations = new Map();
  for (const requirement of state.outcome_requirements) {
    if (!executions.has(requirement.workflow_execution_id) || requirement.immutable !== true)
      throw migrationError('outcome_requirement_reference_invalid', { id: requirement.id });
    if (!/^[a-f0-9]{64}$/.test(String(requirement.contract_hash || '')))
      throw migrationError('outcome_requirement_contract_hash_invalid', { id: requirement.id });
    if (['context', 'security'].includes(requirement.scope) && requirement.waivable)
      throw migrationError('outcome_requirement_nonwaivable_scope_invalid', { id: requirement.id });
  }
  for (const evaluation of state.outcome_evaluations) {
    const requirement = requirements.get(evaluation.requirement_id);
    if (
      !requirement ||
      requirement.workflow_execution_id !== evaluation.workflow_execution_id ||
      evaluation.immutable !== true ||
      !['pending', 'satisfied', 'unsatisfied', 'waived', 'error'].includes(evaluation.status)
    )
      throw migrationError('outcome_evaluation_invalid', { id: evaluation.id });
    const list = evaluations.get(evaluation.requirement_id) || [];
    list.push(evaluation);
    evaluations.set(evaluation.requirement_id, list);
  }
  const grants = new Map();
  for (const waiver of state.outcome_waivers) {
    if (waiver.immutable !== true || !['grant', 'revoke'].includes(waiver.action))
      throw migrationError('outcome_waiver_invalid', { id: waiver.id });
    if (!executions.has(waiver.workflow_execution_id))
      throw migrationError('outcome_waiver_execution_missing', { id: waiver.id });
    for (const requirementId of waiver.requirement_ids || []) {
      const requirement = requirements.get(requirementId);
      if (!requirement || requirement.workflow_execution_id !== waiver.workflow_execution_id)
        throw migrationError('outcome_waiver_requirement_invalid', { id: waiver.id, requirement_id: requirementId });
      if (!requirement.waivable)
        throw migrationError('outcome_waiver_requirement_nonwaivable', {
          id: waiver.id,
          requirement_id: requirementId
        });
    }
    if (waiver.action === 'grant') {
      const duration = Date.parse(waiver.expires_at || '') - Date.parse(waiver.created_at || '');
      if (!(duration > 0 && duration <= 30 * 24 * 60 * 60 * 1000))
        throw migrationError('outcome_waiver_expiry_invalid', { id: waiver.id });
      grants.set(waiver.id, waiver);
    } else if (!grants.has(waiver.revokes_waiver_id))
      throw migrationError('outcome_waiver_revoke_reference_invalid', { id: waiver.id });
  }
  for (const execution of state.workflow_executions) {
    if (!COMPLETION_STATUSES.includes(execution.completion_status))
      throw migrationError('workflow_completion_status_invalid', { id: execution.id });
    if (execution.release_eligible && !['completed', 'waived'].includes(execution.completion_status))
      throw migrationError('workflow_release_eligibility_invalid', { id: execution.id });
    if (
      execution.completion_status === 'legacy_unassessed' &&
      [...evaluations.values()].flat().some((item) => item.workflow_execution_id === execution.id)
    )
      throw migrationError('legacy_unassessed_evaluation_forbidden', { id: execution.id });
  }
}

function validateStageCheckpoints(state) {
  ensureUniqueIds(state.execution_stage_checkpoints, 'execution_stage_checkpoints');
  const checkpointById = new Map();
  const sequences = new Set();
  for (const checkpoint of state.execution_stage_checkpoints) {
    parseExecutionCheckpoint(checkpoint);
    if (!state.workflow_executions.some((item) => item.id === checkpoint.workflow_execution_id))
      throw migrationError('execution_checkpoint_workflow_missing', { id: checkpoint.id });
    if (
      checkpoint.task_execution_id &&
      !state.task_executions.some(
        (item) =>
          item.id === checkpoint.task_execution_id && item.workflow_execution_id === checkpoint.workflow_execution_id
      )
    )
      throw migrationError('execution_checkpoint_task_missing', { id: checkpoint.id });
    const sequenceKey = `${checkpoint.task_execution_id || checkpoint.workflow_execution_id}:${checkpoint.sequence}`;
    if (sequences.has(sequenceKey))
      throw migrationError('execution_checkpoint_sequence_duplicate', { id: checkpoint.id });
    sequences.add(sequenceKey);
    checkpointById.set(checkpoint.id, checkpoint);
  }
  for (const checkpoint of state.execution_stage_checkpoints) {
    if (!checkpoint.replay_of_checkpoint_id) continue;
    const prior = checkpointById.get(checkpoint.replay_of_checkpoint_id);
    if (!prior || prior.stage !== checkpoint.stage || prior.sequence >= checkpoint.sequence)
      throw migrationError('execution_checkpoint_replay_reference_invalid', { id: checkpoint.id });
  }
  for (const execution of state.task_executions) {
    if (execution.current_stage && !EXECUTION_STAGES.includes(execution.current_stage))
      throw migrationError('task_execution_stage_invalid', { id: execution.id });
    for (const checkpointId of execution.stage_checkpoint_ids || [])
      if (checkpointById.get(checkpointId)?.task_execution_id !== execution.id)
        throw migrationError('task_execution_checkpoint_reference_invalid', {
          id: execution.id,
          checkpoint_id: checkpointId
        });
  }
}

export function assertV21AppendOnly(before, after) {
  for (const collection of V21_OUTCOME_COLLECTIONS) {
    const nextById = new Map((after[collection] || []).map((item) => [item.id, item]));
    for (const item of before[collection] || []) {
      const next = nextById.get(item.id);
      if (next === item) continue;
      if (!next || JSON.stringify(item) !== JSON.stringify(next))
        throw migrationError('v21_immutable_record_changed', { collection, id: item.id });
    }
  }
}

export async function migrateStateFileToV21(
  stateFile,
  {
    backupDirectory = path.join(path.dirname(stateFile), 'migrations'),
    clock = () => new Date(),
    beforeReplace,
    afterReplace
  } = {}
) {
  const original = await fsp.readFile(stateFile),
    parsed = JSON.parse(original.toString('utf8')),
    result = migrateState20To21(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated)
    return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };
  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-'),
    backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`),
    manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`),
    migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8'),
    tempPath = `${stateFile}.v21-${process.pid}-${Date.now()}.tmp`,
    manifest = {
      migration: `aiws-state-${result.from_version}-to-21`,
      status: 'prepared',
      from_schema: result.from_version,
      to_schema: 21,
      created_at: clock().toISOString(),
      original_sha256: sha256(original),
      original_state_hash: canonicalStateHash(parsed),
      migrated_sha256: sha256(migratedBytes),
      migrated_state_hash: canonicalStateHash(result.state),
      backup_file: path.basename(backupPath),
      state_file: path.basename(stateFile)
    };
  await writeExclusiveAndSync(backupPath, original);
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    validateState21(JSON.parse((await fsp.readFile(tempPath)).toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    validateState21(JSON.parse((await fsp.readFile(stateFile)).toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    Object.assign(manifest, { status: 'committed', committed_at: clock().toISOString() });
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return {
      ...result,
      state_hash: manifest.migrated_state_hash,
      backup_path: backupPath,
      manifest_path: manifestPath,
      manifest
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (replaced) await atomicRewrite(stateFile, original);
    Object.assign(manifest, {
      status: 'rolled_back',
      failed_at: clock().toISOString(),
      error: safeErrorCode(error)
    });
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function emptyOutcomeSummary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function ensureUniqueIds(values, collection) {
  const ids = new Set();
  for (const item of values) {
    if (!item?.id || ids.has(item.id))
      throw migrationError('state_collection_id_invalid', { collection, id: item?.id || null });
    ids.add(item.id);
  }
}

function migrationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function safeErrorCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed';
}

async function writeExclusiveAndSync(file, bytes) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicRewrite(file, bytes) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeExclusiveAndSync(temp, bytes);
  await replaceFile(temp, file);
}

async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
