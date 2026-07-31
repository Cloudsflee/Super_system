import { taskEffectRunnerResultSchema } from './task-effects.mjs';
import { executionAssetVersionIds, executionContextDocumentVersionIds } from './runner-context-utils.mjs';

export function nodeRunResultSchema() {
  return {
    type: 'object',
    required: ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'],
    properties: {
      status: { enum: ['succeeded', 'partial', 'blocked', 'failed'] },
      summary: { type: 'string' },
      changed_files: { type: 'array' },
      asset_candidates: { type: 'array' },
      test_results: { type: 'array' },
      next_actions: { type: 'array' },
      warnings: { type: 'array' }
    }
  };
}

export function taskRunnerResultSchema(context = null) {
  if (['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(context?.schema_version))
    return taskEffectRunnerResultSchema(context);
  const outputKeys = (context?.contract?.expected_outputs || []).map((item) => item.key).filter(Boolean);
  const fields = legacyRunnerSchemaFields(context);
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema_version',
      'status',
      'summary',
      'outputs',
      'consumed_input_versions',
      'consumed_context_document_versions',
      'input_dispositions',
      'context_dispositions',
      'synthetic_fallback',
      'warnings'
    ],
    properties: {
      schema_version: { enum: ['aiws.task_runner_result.v2'] },
      status: { enum: ['succeeded', 'partial', 'blocked', 'failed'] },
      summary: { type: 'string' },
      consumed_input_versions: fields.consumedVersions,
      consumed_context_document_versions: fields.consumedContextVersions,
      input_dispositions: { type: 'array', items: fields.inputDisposition },
      context_dispositions: { type: 'array', items: fields.contextDisposition },
      synthetic_fallback: { type: 'boolean' },
      outputs: {
        type: 'array',
        items: legacyRunnerOutputSchema(outputKeys, fields)
      },
      warnings: fields.stringArray
    }
  };
}

export function runnerResultSchemaForContext(context) {
  return [
    'aiws.task_execution_context.v3',
    'aiws.task_execution_context.v4',
    'aiws.task_execution_context.v5'
  ].includes(context?.schema_version)
    ? taskRunnerResultSchema(context)
    : nodeRunResultSchema();
}

function legacyRunnerSchemaFields(context) {
  const inputVersionIds = executionAssetVersionIds(context);
  const contextDocumentVersionIds = executionContextDocumentVersionIds(context);
  const stringArray = { type: 'array', items: { type: 'string' } };
  const consumedVersions = {
    type: 'array',
    description: `Only AssetVersion IDs from inputs[].asset_versions[].version_id. Exact available set: ${JSON.stringify(inputVersionIds)}.`,
    items: inputVersionIds.length ? { type: 'string', enum: inputVersionIds } : { type: 'string' }
  };
  const consumedContextVersions = {
    type: 'array',
    description: `Only exact ContextDocumentVersion IDs actually used: initial system_context IDs ${JSON.stringify(contextDocumentVersionIds)} or provenance_claim.document_version_id returned by aiws_context read during this run. The server validates the read receipt.`,
    items: { type: 'string', minLength: 1, maxLength: 200 }
  };
  return {
    stringArray,
    consumedVersions,
    consumedContextVersions,
    inputDisposition: dispositionSchema('version_id', inputVersionIds),
    contextDisposition: dispositionSchema('document_version_id')
  };
}

function dispositionSchema(idKey, ids = null) {
  const idSchema = ids?.length
    ? { type: 'string', enum: ids }
    : idKey === 'document_version_id'
      ? { type: 'string', minLength: 1, maxLength: 200 }
      : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: [idKey, 'disposition', 'reason'],
    properties: {
      [idKey]: idSchema,
      disposition: { enum: ['used', 'not_used'] },
      reason: { type: 'string' }
    }
  };
}

function legacyRunnerOutputSchema(outputKeys, fields) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'output_key',
      'asset_type',
      'title',
      'summary',
      'payload',
      'evidence_refs',
      'consumed_input_versions',
      'consumed_context_document_versions',
      'input_dispositions',
      'context_dispositions',
      'purpose',
      'consumer_hint',
      'input_relations',
      'unresolved_questions',
      'limitations'
    ],
    properties: {
      output_key: outputKeys.length ? { enum: outputKeys } : { type: 'string' },
      asset_type: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      payload: typedPayloadSchema(),
      evidence_refs: fields.stringArray,
      consumed_input_versions: fields.consumedVersions,
      consumed_context_document_versions: fields.consumedContextVersions,
      input_dispositions: { type: 'array', items: fields.inputDisposition },
      context_dispositions: { type: 'array', items: fields.contextDisposition },
      purpose: { type: 'string' },
      consumer_hint: { type: 'string' },
      input_relations: inputRelationsSchema(),
      unresolved_questions: fields.stringArray,
      limitations: fields.stringArray
    }
  };
}

function typedPayloadSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['payload_kind', 'media_type', 'content', 'files'],
    properties: {
      payload_kind: {
        enum: ['text', 'json', 'file_set', 'git_bundle', 'test_report', 'external_snapshot', 'binary']
      },
      media_type: { type: 'string' },
      content: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'role', 'media_type', 'content'],
          properties: {
            path: { type: 'string' },
            role: { type: 'string' },
            media_type: { type: 'string' },
            content: { type: 'string' }
          }
        }
      }
    }
  };
}

function inputRelationsSchema() {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'version_id', 'document_version_id'],
      properties: {
        type: { enum: ['derived_from', 'verified_against', 'informed_by'] },
        version_id: { type: 'string' },
        document_version_id: { type: 'string' }
      }
    }
  };
}
