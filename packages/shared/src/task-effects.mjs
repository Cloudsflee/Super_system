import { hashString } from './utils.mjs';

const EFFECT_TYPES = new Set(['basis', 'constraint', 'comparison', 'verification', 'contradiction', 'reference']);

export function effectClaimId(value) {
  const identity = {
    input_key: normalizedText(value?.input_key, 120) || null,
    document_version_id: normalizedText(value?.document_version_id, 200) || null,
    contribution_id: normalizedText(value?.contribution_id, 200) || null,
    version_ids: normalizedIdList(value?.version_ids),
    effect: normalizedText(value?.effect, 80) || null,
    output_keys: normalizedIdList(value?.output_keys),
    criterion_ids: normalizedIdList(value?.criterion_ids),
    statement: normalizedText(value?.statement, 2000) || null,
    evidence_refs: normalizedIdList(value?.evidence_refs)
  };
  return `ec_${hashString(JSON.stringify(identity)).slice(0, 24)}`;
}

export function taskEffectRunnerResultSchema(context) {
  const outputKeys = (context?.contract?.expected_outputs || []).map((item) => item.key).filter(Boolean),
    inputKeys = (context?.inputs || []).map((item) => item.key).filter(Boolean),
    contributionAware = context?.schema_version === 'aiws.task_execution_context.v5',
    contributionIds = (context?.inputs || []).map((item) => item.contribution?.id).filter(Boolean),
    criterionIds = (context?.contract?.expected_outputs || [])
      .flatMap((item) => item.acceptance_criterion_ids || [])
      .filter(Boolean),
    versionIds = executionAssetVersionIds(context),
    stringArray = { type: 'array', items: { type: 'string' } },
    outputKeyArray = {
      type: 'array',
      items: outputKeys.length ? { type: 'string', enum: outputKeys } : { type: 'string' }
    },
    effectProperties = {
      effect: { enum: [...EFFECT_TYPES] },
      output_keys: outputKeyArray,
      ...(contributionAware
        ? {
            criterion_ids: {
              type: 'array',
              items: criterionIds.length ? { type: 'string', enum: criterionIds } : { type: 'string' }
            }
          }
        : {}),
      statement: { type: 'string' },
      evidence_refs: stringArray
    },
    inputEffect = {
      type: 'object',
      additionalProperties: false,
      required: [
        'input_key',
        'version_ids',
        ...(contributionAware ? ['contribution_id'] : []),
        ...Object.keys(effectProperties)
      ],
      properties: {
        input_key: inputKeys.length ? { type: 'string', enum: inputKeys } : { type: 'string' },
        ...(contributionAware
          ? {
              contribution_id: contributionIds.length ? { type: 'string', enum: contributionIds } : { type: 'string' }
            }
          : {}),
        version_ids: {
          type: 'array',
          items: versionIds.length ? { type: 'string', enum: versionIds } : { type: 'string' }
        },
        ...effectProperties
      }
    },
    contextEffect = {
      type: 'object',
      additionalProperties: false,
      required: ['document_version_id', ...Object.keys(effectProperties)],
      properties: {
        document_version_id: { type: 'string' },
        ...effectProperties
      }
    },
    payloadFile = {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'role', 'media_type', 'content'],
      properties: {
        path: { type: 'string' },
        role: { type: 'string' },
        media_type: { type: 'string' },
        content: { type: 'string' }
      }
    },
    output = {
      type: 'object',
      additionalProperties: false,
      required: [
        'output_key',
        'asset_type',
        'title',
        'summary',
        'payload',
        'evidence_refs',
        'purpose',
        'consumer_hint',
        'unresolved_questions',
        'limitations'
      ],
      properties: {
        output_key: outputKeys.length ? { enum: outputKeys } : { type: 'string' },
        asset_type: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['payload_kind', 'media_type', 'content', 'files'],
          properties: {
            payload_kind: {
              enum: ['text', 'json', 'file_set', 'git_bundle', 'test_report', 'external_snapshot', 'binary']
            },
            media_type: { type: 'string' },
            content: { type: 'string' },
            files: { type: 'array', items: payloadFile }
          }
        },
        evidence_refs: stringArray,
        purpose: { type: 'string' },
        consumer_hint: { type: 'string' },
        unresolved_questions: stringArray,
        limitations: stringArray
      }
    };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema_version',
      'status',
      'summary',
      'input_effects',
      'context_effects',
      'outputs',
      'synthetic_fallback',
      'warnings'
    ],
    properties: {
      schema_version: {
        enum: [contributionAware ? 'aiws.task_runner_result.v4' : 'aiws.task_runner_result.v3']
      },
      status: { enum: ['succeeded', 'partial', 'blocked', 'failed'] },
      summary: { type: 'string' },
      input_effects: { type: 'array', items: inputEffect },
      context_effects: { type: 'array', items: contextEffect },
      outputs: { type: 'array', items: output },
      synthetic_fallback: { type: 'boolean' },
      warnings: stringArray
    }
  };
}

export function normalizedEffectList(values, idKey) {
  const normalized = (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && typeof item[idKey] === 'string')
    .map((item) => ({
      [idKey]: item[idKey].trim(),
      ...(idKey === 'input_key' ? { version_ids: normalizedIdList(item.version_ids) } : {}),
      ...(typeof item.contribution_id === 'string' ? { contribution_id: item.contribution_id.trim() } : {}),
      effect: String(item.effect || '').trim(),
      output_keys: normalizedIdList(item.output_keys),
      ...(Array.isArray(item.criterion_ids) ? { criterion_ids: normalizedIdList(item.criterion_ids) } : {}),
      statement: String(item.statement || '').trim(),
      evidence_refs: normalizedIdList(item.evidence_refs)
    }))
    .filter((item) => item[idKey] && item.effect && item.output_keys.length && item.statement);
  const byKey = new Map();
  for (const item of normalized)
    byKey.set(
      `${item[idKey]}:${item.contribution_id || ''}:${item.effect}:${item.output_keys.join(',')}:${(
        item.criterion_ids || []
      ).join(',')}:${(item.version_ids || []).join(',')}`,
      item
    );
  return [...byKey.values()].sort(
    (left, right) =>
      left[idKey].localeCompare(right[idKey]) ||
      left.effect.localeCompare(right.effect) ||
      left.output_keys.join(',').localeCompare(right.output_keys.join(','))
  );
}

export function invalidEffectList(values, idKey, versionsRequired, contributionAware = false) {
  if (!Array.isArray(values)) return true;
  return values.some(
    (item) =>
      !item ||
      typeof item !== 'object' ||
      typeof item[idKey] !== 'string' ||
      !item[idKey].trim() ||
      (versionsRequired && (!Array.isArray(item.version_ids) || invalidIdList(item.version_ids))) ||
      (contributionAware &&
        idKey === 'input_key' &&
        (typeof item.contribution_id !== 'string' || !item.contribution_id.trim())) ||
      (contributionAware &&
        (!Array.isArray(item.criterion_ids) || !item.criterion_ids.length || invalidIdList(item.criterion_ids))) ||
      !EFFECT_TYPES.has(item.effect) ||
      !Array.isArray(item.output_keys) ||
      !item.output_keys.length ||
      invalidIdList(item.output_keys) ||
      typeof item.statement !== 'string' ||
      item.statement.trim().length < 12 ||
      !Array.isArray(item.evidence_refs) ||
      invalidIdList(item.evidence_refs)
  );
}

function executionAssetVersionIds(context) {
  return normalizedIdList(
    (context?.inputs || []).flatMap((item) => item.asset_versions || []).map((item) => item.version_id)
  );
}

function normalizedIdList(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ].sort();
}

function invalidIdList(values) {
  return (Array.isArray(values) ? values : []).some(
    (value) => value != null && value !== '' && typeof value !== 'string'
  );
}

function normalizedText(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
