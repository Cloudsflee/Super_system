/** Presentation-only labels. API values and persisted enum values stay in English. */
const STATUS_LABELS: Record<string, string> = {
  unknown: '未知', pending: '待处理', active: '活跃', inactive: '未启用', ready: '就绪', confirmed: '已确认',
  applied: '已应用', passed: '通过', approved: '已批准', answered: '已回答', completed: '已完成', closed: '已关闭',
  queued: '排队中', running: '运行中', processing: '处理中', critic_pending: '等待审查', proposed: '已生成提案',
  failed: '失败', cancelled: '已取消', rejected: '已拒绝', stale: '已过期', faulted: '故障', archived: '已归档',
  unavailable: '不可用', available: '可用', awaiting_approval: '等待审批', awaiting_input: '等待输入', paused: '已暂停',
  pause_requested: '正在请求暂停', draft: '草稿', draft_pr: '草稿 PR', merged: '已合并', needs_reconcile: '需要对账',
  released: '已发布', deleted: '已删除', revoked: '已撤销', expired: '已过期', probing: '探测中', unprobed: '未探测',
  disabled: '已禁用', enabled: '已启用', preparing: '准备中', checking: '检查中', reviewing: '审阅中', indexing: '索引中',
  sealed: '已封存', orphaned: '进程已丢失', external_result_unknown: '外部结果未知', gap: '存在缺口', connected: '已连接',
  reconnecting: '重新连接中', partial: '部分同步', idle: '空闲', denied: '已拒绝', blocked: '已阻塞',
  completed_with_gaps: '完成但有缺口', confirming: '确认中', executing: '执行中', draft_workflow: '工作流草稿',
  succeeded: '成功', parsed: '已解析', valid: '有效', invalid: '无效', tombstoned: '已封存',
  resource_exceeded: '超出资源限制', awaiting_human: '等待人工处理', waived: '已豁免', included: '已纳入',
  excluded: '已排除', candidate: '候选', planned: '已规划', verifying: '验证中', accepted: '已接受',
  leased: '已租用', submitted: '已提交', source_drift: '源版本漂移', reconciling: '对账中',
  creator_confirmed: '创建者已确认', owner_confirmed: '所有者已确认', prepared: '已准备',
  tombstone_pending: '等待封存', model_advice: '模型建议', public: '公开', private: '私有',
  disconnected: '未连接', pending_review: '等待审阅',
  grant: '授予', revoke: '撤销', comment: '评论', request_changes: '要求修改', resolution: '已解决',
  sending: '发送中', discarded: '已丢弃', superseded: '已被替代',
  paired: '已配对', suspended: '已暂停', rebind_required: '需要重新绑定',
  partially_approved: '部分批准', requested: '已请求', stopped: '已停止', interrupted: '已中断',
  authoritative: '权威', derived: '派生', tombstone: '已封存', full: '完整',
  current: '当前', supported: '支持', locked: '已锁定', quarantined: '已隔离', download_only: '仅可下载',
  preview: '可预览', undone: '已撤销',
  complete: '已完成', done: '已完成', degraded: '能力受限', verified: '已验证', starting: '启动中',
  required: '必需', offline: '离线', online: '在线',
};

const STAGE_LABELS: Record<string, string> = {
  prepare: '准备', context: '上下文', run: '运行', check: '检查', review: '审阅', finalize: '收尾', deliver: '交付'
};

const RUNTIME_LABELS: Record<string, string> = {
  linux_native: 'Linux 原生', windows_native: 'Windows 原生', host: '主机', docker: 'Docker', windows_bridge: 'Windows Bridge'
};

const MODE_LABELS: Record<string, string> = {
  brainstorm: '从零构思', existing: '已有项目', guided: '引导模式', agent: '代理模式', side_thread: '旁支线程',
  project: '项目', workflow: '工作流', workstream: '工作流组', task: '任务', initial: '初始生成', replan: '重新规划',
  read: '读取', write: '写入'
};

const ACTION_LABELS: Record<string, string> = {
  save: '保存', create: '创建', update: '更新', delete: '删除', archive: '归档', restore: '恢复',
  confirm: '确认', cancel: '取消', retry: '重试', refresh: '刷新', review: '审阅', approve: '批准',
  reject: '拒绝', apply: '应用', undo: '撤销', execute: '执行', reconcile: '对账', open: '打开',
  start: '开始', stop: '停止', pause: '暂停', resume: '继续', replay: '重放', probe: '探测', disable: '禁用', enable: '启用',
  merge: '合并', fork: '分叉', waive: '豁免', replace: '替换', read: '读取', write: '写入', run: '运行'
};

const DIMENSION_LABELS: Record<string, string> = {
  coverage: '覆盖度', accuracy: '准确性', depth: '深度', consistency: '一致性', clarity: '清晰度',
  correctness: '正确性', evidence: '证据', completeness: '完整性', relevance: '相关性'
};

const DIMENSION_DESCRIPTIONS: Record<string, string> = {
  coverage: '覆盖所需范围与资产。', accuracy: '声明与输出准确无误。', depth: '工作具备足够的技术深度。',
  consistency: '各工作流工件彼此一致。', clarity: '结果清晰、可理解且便于审阅。',
  correctness: '结果满足正确性要求。', evidence: '证据足以支持结论。', completeness: '工作内容完整。', relevance: '结果与目标相关。'
};

const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  operation_get: '读取操作详情', operation_events: '读取操作事件', operation_cancel: '取消操作',
  setup_session_create: '创建浏览器会话', context_map: '读取上下文图谱', context_search: '搜索上下文',
  context_read: '读取上下文内容', context_packs_list: '列出上下文包', context_pack_get: '读取上下文包',
  context_status: '读取上下文状态', context_rebuild: '重建上下文投影', mcp_rpc: '调用 MCP RPC',
  mcp_tools: '列出 MCP 工具', gateway_forward: '通过网关转发', gateway_receipt: '读取网关回执',
  events_project_replay: '重放项目事件', project_get: '读取项目详情'
};

const DOMAIN_LABELS: Record<string, string> = {
  Project: '项目', project: '项目', Intake: '来源接入', intake: '来源接入', Brief: 'Brief', brief: 'Brief',
  Workflow: '工作流', workflow: '工作流', Generation: '生成', generation: '生成', Critic: 'Critic', critic: 'Critic',
  Repository: '代码仓库', repository: '代码仓库', Requirement: '要求', requirement: '要求',
  Evidence: '证据', evidence: '证据', Assist: 'Assist', assist: 'Assist', Files: '文件', files: '文件',
  Context: '上下文', context: '上下文', Projection: '投影', projection: '投影', Delivery: '交付', delivery: '交付',
  Exchange: '交换', exchange: '交换', Execution: '执行', execution: '执行', MCP: 'MCP', mcp: 'MCP',
  Operations: '运维', operations: '运维', Outcome: '结果', outcome: '结果', Parser: 'Parser', parser: 'Parser',
  asset: '资产', attestation: '证明', goal: '目标', reference: '引用', session: '会话', turn: '轮次',
  attachment: '附件', change: '变更', batch: '批次', node: '节点', pack: '上下文包', packs: '上下文包',
  policy: '策略', source: '来源', selection: '选择', digest: '摘要', test: '测试', result: '结果', trace: '追踪', proposal: '提案',
  grant: '授权', request: '请求', attempt: '尝试', attempts: '尝试', checkpoint: '检查点', checkpoints: '检查点',
  stage: '阶段', file: '文件', client: '客户端', format: '格式', operation: '操作', events: '事件', job: '作业', jobs: '作业',
  code: '代码', terminal: '终端', runner: 'Runner', profile: 'Profile', setup: '系统配置'
};

const COMMAND_TOKEN_LABELS: Record<string, string> = {
  get: '读取', list: '列表', create: '创建', update: '更新', delete: '删除', cancel: '取消', start: '开始',
  pause: '暂停', resume: '继续', retry: '重试', replay: '重放', apply: '应用', approve: '批准', reject: '拒绝',
  review: '审阅', undo: '撤销', attest: '证明', capture: '捕获', read: '读取', search: '搜索', rebuild: '重建',
  submit: '提交', evaluate: '评估', interrupt: '中断', steer: '继续追问', revoke: '撤销', forward: '转发',
  status: '状态', versions: '版本', version: '版本', relations: '关系', relation: '关系',
  follow: '追问', ups: '后续', open: '打开', close: '关闭', prepare: '准备', confirm: '确认', merge: '合并', revise: '修订'
};

const ACTOR_KIND_LABELS: Record<string, string> = {
  system: '系统', user: '用户', service: '服务', agent: '代理'
};

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者', admin: '管理员', member: '成员', observer: '观察者', reviewer: '审阅者',
  creator: '创建者', developer: '开发者'
};

const AUTH_TYPE_LABELS: Record<string, string> = {
  api_key: 'API 密钥', oauth: 'OAuth', chatgpt: 'ChatGPT 账户', keyring_only: '系统密钥环', none: '无'
};

const NODE_KIND_LABELS: Record<string, string> = {
  task: '任务', workstream: '工作流组', root: '根节点', node: '节点'
};

const FIELD_LABELS: Record<string, string> = {
  action: '动作', command: '命令', runtime: '运行时', workspace_id: '工作区', project_id: '项目',
  session_id: '会话', approval_id: '审批', reason: '原因', target_name: '目标名称', target_full_name: '目标完整名称',
  expected_head_sha: '预期 HEAD', source_revision: '源版本', resource: '资源', effect: '效果', scope: '范围',
  assets: '资产', reviewer: '审阅者', policy: '策略', workflow: '工作流', dependencies: '依赖', blockers: '阻塞项'
};

const KIND_LABELS: Record<string, string> = {
  fixture: '本地接入', opaque: '外部引用', manual: '手动', other: '其他', context_source: '上下文来源',
  execution_output: '执行输出', test_result: '测试结果', code_change: '代码变更', attachment: '附件',
  text: '文本', document: '文档', archive: '归档', audio: '音频', video: '视频', image: '图像',
  modified: '已修改', added: '已新增', created: '已创建', removed: '已移除', unchanged: '未变更',
  integrity: '完整性', derived_from: '派生自', produced_by: '产出自', references: '引用', supersedes: '替代',
  observed: '已观测', authoritative: '权威', generated: '已生成', response: '回复', reasoning_summary: '推理摘要',
  workspace: '工作区', 'execution.capture': '执行捕获', evidence_count: '证据数量', test_pass: '测试通过情况',
  send: '发送', receive: '接收', git_bundle: 'Git Bundle', terminal_control: '终端控制',
  diagnostic: '诊断', standard: '标准', light: '轻量'
};

const ERROR_CODE_LABELS: Record<string, string> = {
  source_drift: '源版本漂移', revision_conflict: '修订冲突', permission_denied: '权限不足',
  authentication_required: '需要登录', session_invalid: '会话无效', session_expired: '会话已过期',
  session_revoked: '会话已撤销', rebind_required: '需要重新绑定凭据', resource_exceeded: '超出资源限制',
  network_error: '网络错误', request_failed: '请求失败', platform_mismatch: '当前平台不匹配',
  reference_race: '引用发生并发变更', intake_failed: '来源接入失败'
};

const COMMAND_LABELS: Record<string, string> = {
  Project: '项目', Intake: '来源接入', Brief: 'Brief', Workflow: '工作流', Generation: '生成', Critic: 'Critic 审查',
  Repository: '代码仓库', Requirement: '验收要求', 'Archive project': '归档项目', 'Restore project': '恢复项目',
  'Prepare deletion': '准备删除', 'Confirm deletion': '确认删除', 'Execute deletion': '执行删除',
  'Prepare repository deletion': '准备删除代码仓库', 'Execute repository deletion': '执行代码仓库删除',
  'Reconcile repository deletion': '对账代码仓库删除', 'Cancel repository deletion': '取消代码仓库删除',
  'Retry intake': '重试来源接入', 'Cancel intake': '取消来源接入', 'Confirm brief': '确认 Brief',
  'Apply proposal': '应用提案', 'Retry generation': '重试生成', 'Cancel generation': '取消生成',
  'Repository creator confirmation': '代码仓库创建者确认', 'Repository owner confirmation': '代码仓库所有者确认',
  'command.execute': '执行命令', 'terminal.open': '打开终端', 'backup.create': '创建备份',
  'restore.prepare': '准备恢复', 'system.reset.prepare': '准备系统重置', 'cas.gc.apply': '应用 CAS GC'
};

export function statusLabel(value: unknown): string {
  const raw = String(value ?? 'unknown');
  return STATUS_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function stageLabel(value: unknown): string {
  const raw = String(value ?? '');
  return STAGE_LABELS[raw] || statusLabel(raw);
}

export function runtimeLabel(value: unknown): string {
  const raw = String(value ?? '');
  return RUNTIME_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function modeLabel(value: unknown): string {
  const raw = String(value ?? '');
  return MODE_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function actionLabel(value: unknown): string {
  const raw = String(value ?? '');
  return ACTION_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function commandLabel(value: unknown): string {
  const raw = String(value ?? '');
  if (COMMAND_LABELS[raw]) return COMMAND_LABELS[raw];
  return semanticIdentifierLabel(raw);
}

export function dimensionLabel(value: unknown): string {
  const raw = String(value ?? '');
  return DIMENSION_LABELS[raw] || DIMENSION_LABELS[raw.toLowerCase()] || raw.replaceAll('_', ' ');
}

export function dimensionDescriptionLabel(key: unknown, fallback?: unknown): string {
  const raw = String(key ?? '').toLowerCase();
  return DIMENSION_DESCRIPTIONS[raw] || String(fallback ?? dimensionLabel(raw));
}

export function mcpToolDescriptionLabel(name: unknown, fallback?: unknown): string {
  const raw = String(name ?? '');
  if (MCP_TOOL_DESCRIPTIONS[raw]) return MCP_TOOL_DESCRIPTIONS[raw];
  const description = String(fallback ?? raw);
  const [owner, ...command] = description.split(/\s+/);
  if (command.length && DOMAIN_LABELS[owner]) {
    const commandText = command.join(' ');
    const parts = commandText.split(/[._\s-]+/).filter(Boolean);
    if (parts[0]?.toLowerCase() === owner.toLowerCase()) parts.shift();
    return `${DOMAIN_LABELS[owner]}：${semanticIdentifierLabel(parts.join('.'))}`;
  }
  return semanticIdentifierLabel(description);
}

export function roleLabel(value: unknown): string {
  const raw = String(value ?? '');
  return ({ user: '用户', assistant: '助手', system: '系统', tool: '工具', developer: '开发者', ...ROLE_LABELS } as Record<string, string>)[raw] || raw.replaceAll('_', ' ');
}

export function actorKindLabel(value: unknown): string {
  const raw = String(value ?? '');
  return ACTOR_KIND_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function authTypeLabel(value: unknown): string {
  const raw = String(value ?? '');
  return AUTH_TYPE_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function nodeKindLabel(value: unknown): string {
  const raw = String(value ?? '');
  return NODE_KIND_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function fieldLabel(value: unknown): string {
  const raw = String(value ?? '');
  return FIELD_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function kindLabel(value: unknown): string {
  const raw = String(value ?? '');
  return KIND_LABELS[raw] || raw.replaceAll('_', ' ');
}

export function errorCodeLabel(value: unknown): string {
  const raw = String(value ?? '');
  return ERROR_CODE_LABELS[raw] || statusLabel(raw);
}

export function listLabel(value: unknown, fallback = '无'): string {
  if (value == null || value === '') return fallback;
  return String(value);
}

function semanticIdentifierLabel(value: string): string {
  return String(value || '').split(/[._\s-]+/).filter(Boolean).map((token) => DOMAIN_LABELS[token] || COMMAND_TOKEN_LABELS[token] || ACTION_LABELS[token] || token).join(' · ');
}
