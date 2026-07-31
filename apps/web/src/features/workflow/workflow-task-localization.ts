export const CHINESE_STAGE_REQUIREMENTS: Record<string, string> = {
  research_evidence: '梳理输入材料、来源位置和验证证据，确保结论可追溯。',
  constraint_analysis: '明确约束、风险、失败边界和不可变要求。',
  solution_decision: '基于已确认约束形成可实施、可复核的方案决策。',
  execution: '按已确认方案实施，并将成果绑定到精确版本。',
  acceptance: '针对同一实现版本执行确定性验证并保留验收证据。',
  integration_delivery: '仅集成已验收成果，并保留完整的交付追溯关系。'
};

export const CHINESE_CONTEXT_RULES: Array<[RegExp, string]> = [
  [/\bread[- ]only\b|\bno[- ]write\b|write nothing|do not modify|never modify/i, '只读执行'],
  [/\b(?:fixed|exact|same)[ -]?sha\b|repository snapshot|immutable repository/i, '固定 SHA'],
  [/\boffline\b/i, '离线运行'],
  [/\bidempoten\w*\b|\bdeterministic\w*\b|per-date lock/i, '确定性与幂等'],
  [/\bredact\w*\b|\bcredential\w*\b|\bsecret\w*\b/i, '敏感信息脱敏'],
  [/structured output|\bjson\b|\bschema\b/i, '结构化输出'],
  [/fail[- ]closed/i, '失败时闭合'],
  [/\btest\w*\b|\bacceptance\b|\bevidence\b|\baudit\b/i, '测试与验收证据']
];
