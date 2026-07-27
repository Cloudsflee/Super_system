const STATUS_LABELS: Record<string, string> = {
  all: '全部',
  accepted: '已接受',
  active: '已启用',
  archived: '已归档',
  approved: '已批准',
  applied: '已应用',
  available: '可用',
  awaiting_human: '等待人工处理',
  blocked: '已阻塞',
  cancelled: '已取消',
  candidate: '候选',
  authorization_required: '需要授权',
  changes_requested: '需要修改',
  checking: '检查中',
  configured: '已配置',
  configuration_required: '需要配置',
  connected: '已连接',
  closed: '已关闭',
  completed: '已完成',
  completed_with_failures: '完成但有失败',
  confirmed: '已确认',
  created: '已创建',
  degraded: '部分可用',
  disputed: '有争议',
  draft: '草稿',
  draft_open: '草稿已创建',
  disabled: '已禁用',
  failed: '失败',
  healthy: '正常',
  inactive: '未启用',
  invalid: '无效',
  local: '本地模式',
  merged: '已合并',
  missing: '缺失',
  needs_review: '等待验收',
  not_started: '尚未启动',
  off: '已关闭',
  open: '已开启',
  paused: '已暂停',
  pending: '待处理',
  pending_approval: '待审批',
  proposed: '待批准',
  queued: '已排队',
  ready: '已就绪',
  rejected: '已退回',
  installation_required: '需要安装',
  ready_for_submission: '可以提交',
  repository_selection_required: '需要选择代码仓库',
  required: '必须配置',
  revoked: '已撤销',
  running: '运行中',
  runtime_required: '需要运行环境',
  stale: '已过期',
  submitted: '已提交',
  succeeded: '成功',
  superseded: '已替代',
  synced: '已同步',
  unavailable: '不可用',
  unhealthy: '异常',
  unsupported: '不受支持',
  validated: '已验证',
  verifying: '验证中',
  waiting: '等待中'
};

const EXECUTOR_LABELS: Record<string, string> = {
  manual: '人工处理',
  codex_docker: 'Codex 自动执行',
  repository_integrate: '代码仓库集成',
  artifact_generate: '资产生成',
  research: '调研执行',
  analysis: '分析执行',
  code: '代码执行',
  test: '测试执行',
  review: '验收执行',
  deploy: '部署执行',
  integration: '集成执行'
};

const CHECK_LABELS: Record<string, string> = {
  pending: '等待检查',
  queued: '检查已排队',
  running: '检查中',
  passed: '检查通过',
  success: '检查通过',
  succeeded: '检查通过',
  failed: '检查失败',
  skipped: '已跳过',
  unknown: '检查状态未知'
};

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  collaborator: '协作者',
  viewer: '只读成员',
  admin: '管理员',
  user: '成员'
};

export function displayStatus(value?: string | null) {
  if (!value) return '状态未知';
  return STATUS_LABELS[value] || '其他状态';
}

export function executorLabel(value?: string | null) {
  if (!value) return '执行方式未知';
  return EXECUTOR_LABELS[value] || '系统执行';
}

export function checkStatusLabel(value?: string | null) {
  if (!value) return '检查状态未知';
  return CHECK_LABELS[value] || '其他检查状态';
}

export function roleLabel(value?: string | null) {
  if (!value) return '成员';
  return ROLE_LABELS[value] || '成员';
}

export function confirmationPolicyLabel(value?: string | null) {
  return (
    (
      { human: '人工确认', evidence: '证据确认', system_evidence: '系统证据确认', automatic: '自动确认' } as Record<
        string,
        string
      >
    )[value || ''] || '证据确认'
  );
}

export function pullRequestStatusLabel(value?: string | null) {
  return (
    (
      {
        proposed: '等待批准创建',
        draft_open: '草稿已创建',
        ready: '可以合并',
        merged: '已合并',
        closed: '已关闭',
        failed: '处理失败'
      } as Record<string, string>
    )[value || ''] || '处理中'
  );
}

export function traceEventLabel(value?: string | null) {
  const labels: Record<string, string> = {
    'assist.message.created': '助手消息已创建',
    'assist.session.created': '助手会话已创建',
    'change_proposal.applied': '变更提案已应用',
    'change_proposal.approved': '变更提案已批准',
    'change_proposal.created': '变更提案已创建',
    'change_proposal.deferred': '变更提案已暂缓',
    'codex.probe.completed': 'Codex 连接检查完成',
    'codex.profile.created': 'Codex 配置已创建',
    'context_pack.generated': '上下文包已生成',
    'delivery.completed': '交付已完成',
    'delivery.failed': '交付失败',
    'delivery.policy.approved': '交付策略已批准',
    'delivery.pull_request.merged': '交付合并请求已合并',
    'delivery.started': '交付已启动',
    'github.webhook.received': '已接收 GitHub 通知',
    'integration.synced': '集成已同步',
    'mcp.client.created': 'MCP 客户端已创建',
    'mcp.client.revoked': 'MCP 客户端已撤销',
    'memory.manifest.generated': '记忆清单已生成',
    'memory.sufficiency.checked': '记忆充分性已检查',
    'node_run.approval.consumed': '节点运行审批已使用',
    'node_run.queued': '节点运行已排队',
    'node_run.started': '节点运行已启动',
    'pull_request.intent.approved': '合并请求意图已批准',
    'pull_request.intent.created': '合并请求意图已创建',
    'pull_request.intent.merged': '合并请求已合并',
    'pull_request.intent.proposed': '合并请求意图待批准',
    'pull_request.intent.reconciled': '合并请求状态已同步',
    'repository.target.updated': '代码仓库目标已更新',
    'repository.workspace.created': '代码仓库工作副本已创建',
    'repository.workspace.refreshed': '代码仓库工作副本已刷新',
    'runner.completed': '执行器已完成',
    'runner.failed': '执行器失败',
    'runner.invoked': '执行器已调用',
    'runner.output': '执行器产生输出',
    'runtime_approval.decided': '运行审批已处理',
    'workflow.generation.queued': '工作流生成已排队'
  };
  return labels[value || ''] || '系统事件';
}

export function scopeTypeLabel(value?: string | null) {
  return (
    (
      { project: '项目', workflow: '工作流', workstream: '工作流分组', task: '任务', node: '节点' } as Record<
        string,
        string
      >
    )[value || ''] || '工作空间'
  );
}

export function changeTypeLabel(value?: string | null) {
  const labels: Record<string, string> = {
    workflow_graph_patch: '工作流结构变更',
    node_contract_patch: '节点契约变更',
    node_run_write: '节点运行授权',
    git_commit: 'Git 提交授权',
    git_publish: 'Git 发布授权',
    record_only: '仅记录变更',
    general: '常规变更'
  };
  return labels[value || ''] || '工作空间变更';
}

export function assetTypeLabel(value?: string | null) {
  const labels: Record<string, string> = {
    DecisionAsset: '决策资产',
    CodeChangeAsset: '代码变更资产',
    ResearchEvidenceAsset: '调研证据资产',
    ConstraintAnalysisAsset: '约束分析资产',
    SolutionDecisionAsset: '方案决策资产',
    ExecutionResultAsset: '执行结果资产',
    TestReportAsset: '测试报告资产',
    TestEvidenceAsset: '测试证据资产',
    IntegrationEvidenceAsset: '集成证据资产',
    RepositoryVersionAsset: '代码仓库版本资产',
    AcceptedRepositoryVersionAsset: '已验收代码仓库版本',
    DeliveryEvidenceAsset: '交付证据资产',
    WorkstreamOutcomeAsset: '工作流分组成果资产',
    decision: '决策资产',
    research: '调研资产',
    analysis: '分析资产',
    execution: '执行资产',
    code: '代码资产',
    test: '测试资产',
    review: '验收资产',
    artifact: '交付资产'
  };
  return labels[value || ''] || '业务资产';
}

export function payloadKindLabel(value?: string | null) {
  return (
    (
      {
        text: '文本',
        json: 'JSON 数据',
        file_set: '文件集',
        git_bundle: 'Git 数据包',
        test_report: '测试报告',
        external_snapshot: '外部快照',
        binary: '二进制',
        legacy: '旧版格式'
      } as Record<string, string>
    )[value || ''] || '未知格式'
  );
}

export function inputKindLabel(value?: string | null) {
  return (
    (
      {
        context: '上下文',
        asset: '资产',
        asset_version: '资产版本',
        repository: '代码仓库',
        file: '文件',
        text: '文本'
      } as Record<string, string>
    )[value || ''] || '业务数据'
  );
}

export function capabilityTagLabel(value: string) {
  const labels: Record<string, string> = {
    research_evidence: '调研取证',
    constraint_analysis: '约束分析',
    solution_decision: '方案决策',
    execution: '实现执行',
    acceptance: '测试验收',
    integration_delivery: '集成交付'
  };
  return labels[value] || (/[^\x00-\x7F]/.test(value) ? value : '扩展能力');
}

export function taskKindLabel(value?: string | null) {
  const labels: Record<string, string> = {
    research: '调研',
    analysis: '分析',
    design: '设计',
    content: '内容',
    code: '编码',
    test: '测试',
    review: '验收',
    deploy: '部署',
    manual: '人工处理',
    integration: '集成'
  };
  return labels[value || ''] || '执行任务';
}

export function reasoningEffortLabel(value?: string | null) {
  const labels: Record<string, string> = {
    none: '关闭',
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '最高'
  };
  return labels[value || ''] || '自定义';
}

export function reasoningEffortDescription(value?: string | null, description?: string | null) {
  if (description && /[^\x00-\x7F]/.test(description)) return description;
  const labels: Record<string, string> = {
    none: '不进行额外推理',
    minimal: '最快响应',
    low: '轻量推理',
    medium: '平衡速度与深度',
    high: '深入推理',
    xhigh: '最深入推理'
  };
  return labels[value || ''] || '服务商提供的推理级别';
}

export function referenceKindLabel(value?: string | null) {
  const labels: Record<string, string> = {
    current_editor_file: '当前编辑文件',
    current_editor_selection: '当前编辑选区',
    project_file: '项目文件',
    uploaded_file: '已上传文件'
  };
  return labels[value || ''] || '引用材料';
}

export function modelDescriptionLabel(value?: string | null) {
  if (value && /[^\x00-\x7F]/.test(value)) return value;
  return '服务商提供的模型';
}

export function runtimeUnavailableReasonLabel(value?: string | null) {
  const labels: Record<string, string> = {
    pty_capability_unavailable: '容器终端能力不可用',
    windows_bridge_not_paired: 'Windows 本机桥接尚未配对',
    windows_bridge_offline: 'Windows 本机桥接当前离线',
    windows_bridge_version_incompatible: 'Windows 本机桥接版本不兼容',
    windows_codex_unavailable: 'Windows 本机未安装 Codex',
    windows_codex_version_unsupported: 'Windows 本机 Codex 版本不受支持',
    windows_conpty_unavailable: 'Windows 本机终端能力不可用',
    host_dev_disabled_in_production: '生产环境未启用宿主机终端'
  };
  if (!value) return '正在探测';
  return labels[value] || `运行环境暂不可用（${value}）`;
}

export function previewErrorLabel(value?: string | null) {
  const labels: Record<string, string> = {
    preview_timeout: '预览处理超时',
    image_load_failed: '图片加载失败',
    audio_load_failed: '音频加载失败',
    video_load_failed: '视频加载失败'
  };
  if (!value) return '预览处理失败';
  if (labels[value]) return labels[value];
  const status = value.match(/^preview_(\d{3})$/)?.[1];
  return status ? `预览内容读取失败（HTTP ${status}）` : `预览处理失败（${value}）`;
}

export function templateDomainLabel(value?: string | null) {
  const labels: Record<string, string> = {
    general: '通用',
    product: '产品',
    software: '软件开发',
    research: '调研',
    design: '设计',
    operations: '运营'
  };
  return labels[value || ''] || '自定义领域';
}

export function attestationDecisionLabel(value?: string | null) {
  return (
    ({ accepted: '已验收', approved: '已批准', rejected: '已退回' } as Record<string, string>)[value || ''] || '待验收'
  );
}

export function attestorTypeLabel(value?: string | null) {
  return (
    (
      { human: '人工验收', trusted_verifier: '可信验证器', system: '系统验证', runner: '执行器验证' } as Record<
        string,
        string
      >
    )[value || ''] || '系统验证'
  );
}

export function relationTypeLabel(value?: string | null) {
  return (
    ({ derived_from: '衍生自', evidenced_by: '作为验收证据', supersedes: '替代旧版本' } as Record<string, string>)[
      value || ''
    ] || '关联版本'
  );
}

export function consumerTypeLabel(value?: string | null) {
  return (
    (
      {
        task_execution: '任务执行',
        task_execution_input: '任务输入',
        workstream_outcome: '成果节点验收'
      } as Record<string, string>
    )[value || ''] || '下游流程'
  );
}

export function manifestRoleLabel(value?: string | null) {
  return (
    ({ payload: '载荷', attachment: '附件', evidence: '证据', manifest: '清单' } as Record<string, string>)[
      value || ''
    ] || '文件'
  );
}

export function mcpScopeLabel(value: string) {
  const labels: Record<string, string> = {
    'system:read': '读取系统',
    'project:read': '读取项目',
    'project:write': '修改项目',
    'workflow:read': '读取工作流',
    'workflow:write': '修改工作流',
    'assist:read': '读取智能助手',
    'assist:write': '使用智能助手',
    'runs:read': '读取运行记录',
    'runs:write': '管理运行',
    'files:read': '读取文件',
    'files:write': '修改文件',
    'terminal:read': '读取终端',
    'terminal:write': '管理终端',
    'terminal:execute': '执行终端命令',
    'git:read': '读取 Git',
    'git:write': '修改 Git',
    'github:read': '读取 GitHub',
    'github:write': '修改 GitHub',
    'assets:read': '读取资产',
    'assets:write': '修改资产',
    'governance:read': '读取治理信息',
    'governance:write': '修改治理信息',
    'approval:read': '读取审批',
    'approval:decide': '处理审批',
    'setup:read': '读取配置',
    'setup:admin': '管理系统配置',
    'mcp:admin': '管理 MCP 客户端',
    'destructive:execute': '执行危险操作',
    'exchange:read': '读取交换数据',
    'exchange:write': '修改交换数据',
    'context:read': '读取上下文地图',
    'context:admin': '管理上下文投影',
    'project:create': '创建项目',
    'project:share': '共享项目'
  };
  return labels[value] || '扩展权限';
}

export function setupDetailLabel(value?: string | null) {
  if (!value) return '';
  if (/^\d+ repositories$/.test(value)) return value.replace(' repositories', ' 个代码仓库');
  return (
    (
      {
        'GitHub 尚未完成验证与 repository 选择': 'GitHub 尚未完成验证与代码仓库选择',
        'Docker Runtime 不可用': 'Docker 运行环境不可用',
        'Profile、凭据、配置或镜像已变化，请重新运行 Probe': 'Codex 配置、凭据或镜像已变化，请重新运行探针',
        '完成 Docker、凭据、Profile 与 Probe': '完成 Docker、凭据、Codex 配置与探针',
        '完成 GitHub Owner 授权': '完成 GitHub 所有者授权',
        '安装 GitHub App 并同步 repository': '安装 GitHub App 并同步代码仓库',
        '选择至少一个 repository': '选择至少一个代码仓库'
      } as Record<string, string>
    )[value] || value
  );
}
