import {
  OUTCOME_CONTRACT_SCHEMA,
  QUALITY_RUBRIC_SCHEMA,
  parseOutcomeContract,
  parseQualityRubric,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';

const CONTENT_KINDS = /research|content|writing|analysis|report|design|editorial|document/i;
const DELIVERY_KINDS = /deploy|delivery|publish|release|notify|webhook/i;

export function applyWorkflowOutcomeProtocols(workflow, nodes, { source = 'declared' } = {}) {
  const tasks = (nodes || []).filter((item) => item.role === 'task' && !item.legacy_read_only),
    contentTasks = tasks.filter(isContentTask),
    requirements = tasks
      .filter((task) => task.required !== false)
      .map((task, index) => ({
        id: `task_acceptance:${task.id}`,
        title: `${task.title || task.id}完成并通过验收`,
        description: '任务 lifecycle 必须完成，且输出已通过声明的 confirmation policy。',
        mandatory: true,
        scope: 'task',
        task_id: task.id,
        order: index,
        evaluator: 'task_acceptance',
        expected: { status: 'completed' },
        waivable: true,
        evaluator_config: {}
      }));
  requirements.push({
    id: 'context_freshness',
    title: '执行上下文保持新鲜且精确绑定',
    description: '所有执行使用的 ContextDocumentVersion 必须仍与权威 source hash 一致。',
    mandatory: true,
    scope: 'context',
    order: requirements.length,
    evaluator: 'context_freshness',
    expected: { current: true },
    waivable: false,
    evaluator_config: {}
  });
  for (const task of tasks.filter((item) => DELIVERY_KINDS.test(`${item.task_kind || ''} ${item.title || ''}`)))
    requirements.push({
      id: `delivery_receipt:${task.id}`,
      title: `${task.title || task.id}具有可信投递回执`,
      mandatory: true,
      scope: 'delivery',
      task_id: task.id,
      order: requirements.length,
      evaluator: 'delivery_receipt',
      expected: { statuses: ['delivered', 'completed', 'sent'] },
      waivable: true,
      evaluator_config: {}
    });
  const criteria = contentTasks.length
    ? contentRubricCriteria(contentTasks)
    : [
        {
          id: 'non_content_not_applicable',
          title: '内容深度验收不适用于此 Workflow',
          evaluator: 'evidence_refs',
          mandatory: false,
          applicable: false,
          expected: null,
          authority_mapping: {}
        }
      ];
  const contract = parseOutcomeContract({
      schema_version: OUTCOME_CONTRACT_SCHEMA,
      version: Number(workflow.workflow_revision || workflow.version || 1),
      source,
      requirements
    }),
    rubric = parseQualityRubric({
      schema_version: QUALITY_RUBRIC_SCHEMA,
      version: Number(workflow.workflow_revision || workflow.version || 1),
      criteria
    });
  Object.assign(workflow, {
    outcome_contract: contract,
    quality_rubric: rubric,
    outcome_contract_hash: protocolHash(contract),
    quality_rubric_hash: protocolHash(rubric),
    protocols: {
      ...(workflow.protocols || {}),
      outcome_contract: OUTCOME_CONTRACT_SCHEMA,
      quality_rubric: QUALITY_RUBRIC_SCHEMA
    }
  });
  return workflow;
}

function contentRubricCriteria(tasks) {
  const authorityMapping = Object.fromEntries(tasks.map((task) => [task.id, 'task_output_authority']));
  return [
    {
      id: 'source_evidence',
      title: '原始证据引用完整',
      evaluator: 'evidence_refs',
      mandatory: true,
      applicable: true,
      expected: { min_count: Math.max(1, tasks.length) },
      authority_mapping: authorityMapping
    },
    {
      id: 'counterevidence',
      title: '反证或替代解释已记录',
      evaluator: 'json_schema',
      mandatory: true,
      applicable: true,
      expected: { required: ['counterevidence'] },
      authority_mapping: authorityMapping
    },
    {
      id: 'confidence_basis',
      title: '置信度依据可复核',
      evaluator: 'json_schema',
      mandatory: true,
      applicable: true,
      expected: { required: ['confidence_basis'] },
      authority_mapping: authorityMapping
    },
    {
      id: 'authority_mapping',
      title: '声明与权威来源映射完整',
      evaluator: 'json_schema',
      mandatory: true,
      applicable: true,
      expected: { required: ['authority_mapping'] },
      authority_mapping: authorityMapping
    },
    {
      id: 'semantic_human_score',
      title: '语义质量人工评分',
      evaluator: 'human_score',
      mandatory: false,
      applicable: false,
      expected: { min: 0 },
      authority_mapping: {}
    }
  ];
}

function isContentTask(task) {
  if (CONTENT_KINDS.test(`${task.task_kind || ''} ${task.category || ''} ${task.type || ''}`)) return true;
  return (task.output_slots || []).some(
    (slot) => !/code|repository|build|test|deployment|binary/i.test(`${slot.kind || ''} ${slot.asset_type || ''}`)
  );
}
