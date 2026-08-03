export const PROJECT_ID = 'project-v23-quality';
export const WORKFLOW_ID = 'workflow-v23-quality';
export const EXECUTION_ID = 'workflow-execution-v23-quality';

export function contentPayload(suffix) {
  return {
    payload_kind: 'text',
    media_type: 'text/markdown',
    content: [
      '# 内容质量评审报告',
      '',
      '目标：完整覆盖 Quality Review 的验收要求。',
      '证据：所有事实均引用 source:quality-review-browser。',
      '反证：若资产版本变化，旧报告必须立即失效。',
      '边界：模型建议只辅助判断，最终结论由人工评分。',
      '行动：达到冻结阈值后允许发布。',
      suffix
    ].join('\n'),
    files: [],
    metadata: {
      counterevidence: '资产变化会使旧结论失效。',
      confidence_basis: 'CAS、输出绑定和人工逐维评分。',
      authority_mapping: { conclusion: 'source:quality-review-browser' }
    }
  };
}

export function projectFixture(ownerId) {
  return {
    id: PROJECT_ID,
    title: 'AIWS V2.3 Quality Review fixture',
    goal: '验证内容质量门禁的完整浏览器旅程',
    status: 'active',
    onboarding_state: 'confirmed',
    managed_workspace_state: 'ready',
    current_workspace_id: 'workspace-v23-quality-root',
    owner_user_id: ownerId,
    created_by_user_id: ownerId,
    lifecycle_operation: null,
    deleted_at: null,
    settings: {}
  };
}

export function membershipFixture(ownerId) {
  return {
    id: 'membership-v23-quality-owner',
    project_id: PROJECT_ID,
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  };
}

export function workspaceFixtures() {
  return [
    { id: 'workspace-v23-quality-root', project_id: PROJECT_ID, title: 'Project' },
    {
      id: 'workspace-v23-quality-stream',
      project_id: PROJECT_ID,
      workflow_node_id: 'workstream-v23-quality',
      title: '内容质量门禁'
    },
    {
      id: 'workspace-v23-quality-task',
      project_id: PROJECT_ID,
      workflow_node_id: 'task-v23-quality',
      title: '生成质量报告'
    }
  ];
}

export function workflowFixture(timestamp, rubric, rubricHash) {
  return {
    id: WORKFLOW_ID,
    project_id: PROJECT_ID,
    workspace_id: 'workspace-v23-quality-root',
    title: 'V2.3 内容质量门禁',
    goal: '独立模型建议后由人工完成最终评分',
    status: 'active',
    planning_quality: 'verified',
    project_classification: 'content',
    hierarchy_mode: 'canonical',
    workflow_revision: 1,
    version: 1,
    brief_coverage: {},
    quality_review_profile_id: null,
    quality_review_policy: {
      enabled: true,
      mandatory: true,
      strategy: 'v23_default',
      rubric,
      rubric_hash: rubricHash
    },
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function workstreamFixture() {
  return {
    id: 'workstream-v23-quality',
    workflow_id: WORKFLOW_ID,
    workspace_id: 'workspace-v23-quality-stream',
    role: 'workstream',
    title: '内容质量门禁',
    goal: '确认内容满足发布阈值',
    outcome: '具备审计记录的人工裁决',
    category: 'deliverable',
    status: 'completed',
    dependencies: [],
    order_index: 0
  };
}

export function taskFixture() {
  return {
    id: 'task-v23-quality',
    workflow_id: WORKFLOW_ID,
    parent_node_id: 'workstream-v23-quality',
    workspace_id: 'workspace-v23-quality-task',
    role: 'task',
    title: '生成质量报告',
    goal: '生成可独立评审的内容资产',
    outcome: '当前有效内容资产',
    category: 'content',
    status: 'completed',
    task_kind: 'content',
    execution_mode: 'codex',
    execution_revision: 1,
    current_contract_id: 'contract-v23-quality',
    required: true,
    output_slots: [
      { key: 'main', required: true, kind: 'document', asset_type: 'DocumentAsset' },
      { key: 'appendix', required: false, kind: 'document', asset_type: 'DocumentAsset' },
      { key: 'recording', required: false, kind: 'audio', asset_type: 'AudioAsset' }
    ],
    dependencies: [],
    order_index: 1
  };
}

export function contractFixture() {
  return {
    id: 'contract-v23-quality',
    node_id: 'task-v23-quality',
    version: 1,
    expected_inputs: [],
    expected_outputs: [
      { key: 'main', kind: 'asset', required: true, asset_type: 'DocumentAsset' },
      { key: 'appendix', kind: 'asset', required: false, asset_type: 'DocumentAsset' },
      { key: 'recording', kind: 'asset', required: false, asset_type: 'AudioAsset' }
    ],
    acceptance_criteria: ['报告完成并通过内容质量门禁'],
    allowed_tools: []
  };
}

export function executionFixture(timestamp) {
  return {
    id: EXECUTION_ID,
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    workflow_revision: 1,
    input_hash: 'b'.repeat(64),
    status: 'completed',
    completion_status: 'pending',
    release_eligible: false,
    finalization_state: 'completed',
    outcome_summary: outcomeSummary(0),
    outcome_facts: {
      context_freshness: {
        status: 'satisfied',
        actual: { current: true },
        evidence_refs: ['fixture:context-current']
      }
    },
    frontier: [],
    waiting_reasons: [],
    executor_config: { runner_image_digest: 'sha256:v23-quality-browser-fixture' },
    started_at: timestamp,
    completed_at: timestamp,
    finalized_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function outcomeSummary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}
