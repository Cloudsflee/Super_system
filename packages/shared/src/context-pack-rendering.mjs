export function qualityCheckContextPack(content) {
  const checks = {
    has_project_goal: Boolean(content.project?.goal),
    has_node_goal: Boolean(content.node_contract?.node_goal),
    has_acceptance_criteria:
      Array.isArray(content.node_contract?.acceptance_criteria) && content.node_contract.acceptance_criteria.length > 0,
    has_allowed_tools:
      Array.isArray(content.node_contract?.allowed_tools) && content.node_contract.allowed_tools.length > 0,
    has_memory_manifest: Boolean(content.memory_manifest),
    has_sufficiency_check: Boolean(content.sufficiency_check),
    has_return_schema: Boolean(content.return_schema_ref)
  };
  return {
    ...checks,
    passed: Object.values(checks).every(Boolean),
    warnings: [
      ...(!checks.has_acceptance_criteria ? ['缺少验收标准'] : []),
      ...(content.sufficiency_check?.status === 'conflict' ? ['存在记忆冲突，需要用户确认'] : []),
      ...(content.memory_manifest?.warnings || []).map((warning) => `记忆警告：${warning.title} · ${warning.freshness}`)
    ]
  };
}

export function contextPackToMarkdown(contextPack) {
  const content = contextPack.content_json;
  const lines = [
    `# Context Pack ${contextPack.id}`,
    '',
    `- Purpose: ${contextPack.purpose}`,
    `- Receiver: ${contextPack.receiver_name}`,
    `- Token estimate: ${contextPack.token_estimate}`,
    '',
    '## Project',
    `- ${content.project.title}: ${content.project.goal}`,
    '',
    '## Node Contract',
    `Goal: ${content.node_contract.node_goal}`,
    'Acceptance Criteria:'
  ];
  for (const item of content.node_contract.acceptance_criteria || []) lines.push(`- ${item}`);
  if (content.task_execution_context) appendExecutionContext(lines, content.task_execution_context);
  appendMemoryManifest(lines, content.memory_manifest);
  lines.push('', '## Runner Instruction', content.runner_instruction);
  return `${lines.join('\n')}\n`;
}

export function agensAiwsBlock(contextPackPath = '.ai-workspace/context/current.md') {
  return [
    '<!-- AIWS:BEGIN -->',
    '# AI Workspace System Runner Contract',
    '',
    `- 当前任务以 ${contextPackPath} 中的 Context Pack 为准。`,
    '- Context Pack、Confirmed Asset、Decision、NodeContract 的权威性高于 Codex Memory / 旧 Session / AGENTS.md 其他建议。',
    '- 如果发现冲突，必须报告冲突并请求用户确认，不得静默覆盖系统确认事实。',
    '- 运行完成后输出 aiws.node_run_result.v1 结构。',
    '<!-- AIWS:END -->',
    ''
  ].join('\n');
}

export const agentsAiwsBlock = agensAiwsBlock;

function appendExecutionContext(lines, context) {
  lines.push(
    '',
    `## Task Execution Context ${context.schema_version?.endsWith('.v3') ? 'v3' : 'v2'}`,
    '```json',
    JSON.stringify(context, null, 2),
    '```'
  );
}

function appendMemoryManifest(lines, manifest) {
  lines.push('', '## Memory Manifest', 'Included:');
  for (const item of manifest.included) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
  lines.push('Excluded:');
  for (const item of manifest.excluded) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
  lines.push('Warnings:');
  for (const item of manifest.warnings) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
}
