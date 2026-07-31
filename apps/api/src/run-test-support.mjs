import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';

export function testConsumptionFixture(taskExecution, body) {
  if (effectAwareExecution(taskExecution)) return testEffectFixture(taskExecution, body);
  if (body.test_consumption_plan && typeof body.test_consumption_plan === 'object')
    return explicitConsumptionPlanFixture(body.test_consumption_plan);
  return defaultConsumptionFixture(taskExecution, body);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 5000))));
}

export async function applyTestRepositoryChanges(execution, changes) {
  const root = execution.context_snapshot?.repository_checkout?.path;
  if (!root) throw new HttpError(409, { error: 'repository_line_checkout_missing' });
  const source =
    Array.isArray(changes) && changes.length
      ? changes
      : [{ path: `aiws-${execution.task_id}.txt`, content: `Task Execution ${execution.id}\n` }];
  for (const item of source.slice(0, 50)) await applyTestRepositoryChange(root, item);
}

function effectAwareExecution(taskExecution) {
  return ['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(
    taskExecution?.context_snapshot?.schema_version
  );
}

function explicitConsumptionPlanFixture(plan) {
  const plans = Object.values(plan).filter((item) => item && typeof item === 'object');
  return {
    consumedInputVersions: plans.flatMap((item) => item.consumed_input_versions || []),
    consumedContextDocumentVersions: plans.flatMap((item) => item.consumed_context_document_versions || []),
    inputDispositions: plans.flatMap((item) => item.input_dispositions || []),
    contextDispositions: plans.flatMap((item) => item.context_dispositions || []),
    consumptionPlan: plan,
    syntheticFallback: false
  };
}

function defaultConsumptionFixture(taskExecution, body) {
  const inputs = taskExecution?.context_snapshot?.inputs || [];
  const documents = taskExecution?.context_snapshot?.system_context?.document_versions || [];
  const selection = testConsumptionSelection(body);
  const consumedInputVersions = consumedTestInputVersions(inputs, selection);
  const consumedContextDocumentVersions = consumedTestContextVersions(documents, selection);
  const inputDispositions = testInputDispositions(inputs, new Set(consumedInputVersions));
  const contextDispositions = testContextDispositions(documents, new Set(consumedContextDocumentVersions));
  const firstOutput = taskExecution?.context_snapshot?.contract?.expected_outputs?.[0]?.key;
  return {
    consumedInputVersions,
    consumedContextDocumentVersions,
    inputDispositions,
    contextDispositions,
    consumptionPlan: firstOutput
      ? {
          [firstOutput]: {
            consumed_input_versions: consumedInputVersions,
            consumed_context_document_versions: consumedContextDocumentVersions,
            input_dispositions: inputDispositions,
            context_dispositions: contextDispositions
          }
        }
      : null,
    syntheticFallback: syntheticTestFallback(selection, body)
  };
}

function testConsumptionSelection(body) {
  return {
    inputKeys: new Set(Array.isArray(body.test_used_input_keys) ? body.test_used_input_keys : []),
    contextNodeIds: new Set(Array.isArray(body.test_used_context_node_ids) ? body.test_used_context_node_ids : []),
    requiredInputs: body.test_use_required_inputs === true,
    requiredContext: body.test_use_required_context === true
  };
}

function consumedTestInputVersions(inputs, selection) {
  return inputs
    .filter((item) => selection.inputKeys.has(item.key) || (selection.requiredInputs && item.required !== false))
    .flatMap((item) => item.asset_versions || [])
    .map((item) => item.version_id)
    .filter(Boolean);
}

function consumedTestContextVersions(documents, selection) {
  return documents
    .filter(
      (item) => selection.contextNodeIds.has(item.node_id) || (selection.requiredContext && item.required === true)
    )
    .map((item) => item.document_version_id)
    .filter(Boolean);
}

function testInputDispositions(inputs, usedInputs) {
  return inputs.flatMap((input) =>
    (input.asset_versions || []).map((version) => ({
      version_id: version.version_id,
      disposition: usedInputs.has(version.version_id) ? 'used' : 'not_used',
      reason: usedInputs.has(version.version_id)
        ? `Test fixture explicitly uses input slot ${input.key}.`
        : `Test fixture explicitly does not use input slot ${input.key}.`
    }))
  );
}

function testContextDispositions(documents, usedContext) {
  return documents.map((item) => ({
    document_version_id: item.document_version_id,
    disposition: usedContext.has(item.document_version_id) ? 'used' : 'not_used',
    reason: usedContext.has(item.document_version_id)
      ? 'Test fixture explicitly uses this context document.'
      : 'Test fixture explicitly does not use this context document.'
  }));
}

function syntheticTestFallback(selection, body) {
  return (
    !selection.requiredInputs &&
    !selection.requiredContext &&
    !selection.inputKeys.size &&
    !selection.contextNodeIds.size &&
    !body.test_consumption_plan
  );
}

function testEffectFixture(taskExecution, body) {
  const inputs = taskExecution.context_snapshot?.inputs || [];
  const outputKeys = (taskExecution.context_snapshot?.contract?.expected_outputs || []).map((item) => item.key);
  const plans = Object.values(body.test_consumption_plan || {}).filter((item) => item && typeof item === 'object');
  const declaredEffects = plans.flatMap((item) => item.input_effects || []);
  const inputEffects = declaredEffects.length
    ? declaredEffects
    : selectedEffectInputs(inputs, body).map((input) => testInputEffect(input, outputKeys));
  return {
    inputEffects,
    contextEffects: plans.flatMap((item) => item.context_effects || []),
    consumptionPlan: null,
    syntheticFallback: !inputEffects.length && !body.test_consumption_plan
  };
}

function selectedEffectInputs(inputs, body) {
  const usedInputKeys = new Set(Array.isArray(body.test_used_input_keys) ? body.test_used_input_keys : []);
  const useRequiredInputs = body.test_use_required_inputs === true;
  return inputs.filter(
    (input) =>
      usedInputKeys.has(input.key) ||
      (useRequiredInputs && (input.application_policy === 'required' || input.consumption_policy === 'must_use'))
  );
}

function testInputEffect(input, outputKeys) {
  return {
    input_key: input.key,
    version_ids: (input.asset_versions || []).map((item) => item.version_id).filter(Boolean),
    ...(input.contribution ? { contribution_id: input.contribution.id } : {}),
    effect: input.contribution?.effect || 'verification',
    output_keys: effectOutputKeys(input, outputKeys),
    ...(input.contribution ? { criterion_ids: input.contribution.target_criterion_ids } : {}),
    statement: `Test fixture verified how input ${input.key} changes the declared task outputs.`,
    evidence_refs: []
  };
}

function effectOutputKeys(input, fallback) {
  if (input.contribution?.target_output_keys?.length) return input.contribution.target_output_keys;
  return input.target_output_keys?.length ? input.target_output_keys : fallback;
}

async function applyTestRepositoryChange(root, item) {
  const target = path.resolve(root, String(item?.path || ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('\0'))
    throw new HttpError(400, { error: 'test_change_path_invalid' });
  if (item.delete === true) await fsp.rm(target, { force: true });
  else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, String(item.content ?? ''), 'utf8');
  }
}
