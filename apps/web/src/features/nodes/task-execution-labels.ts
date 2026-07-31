export function executionInputSource(source: string) {
  return (
    (
      {
        dependency: '前置任务交付',
        workstream_dependency: '前置成果交付',
        brief: '项目简报',
        decision: '项目决策',
        repository_workspace: '代码仓库快照',
        asset: '固定资产',
        asset_version: '固定资产版本',
        inline: '任务声明'
      } as Record<string, string>
    )[source] || source
  );
}

export function reasonLabel(value: string) {
  return (
    (
      {
        manual_input_required: '等待人工输入',
        pull_request_create_approval_required: '等待批准创建合并请求',
        pull_request_merge_approval_required: '等待批准合并代码',
        task_dependency_waiting: '等待上游任务',
        required_input_missing: '必需输入缺失',
        workstream_dependency_waiting: '等待前置成果节点完成',
        workstream_input_missing: '前置成果版本尚未就绪',
        dependency_contribution_route_missing: '上游交付缺少贡献路线',
        dependency_contribution_route_stale: '上游贡献路线已过期',
        dependency_contribution_manifest_invalid: '上游贡献清单校验失败',
        required_contribution_not_accepted: '必需贡献尚未通过验收'
      } as Record<string, string>
    )[value] || '等待执行条件'
  );
}

export function effectLabel(value: string) {
  return (
    (
      {
        basis: '依据',
        constraint: '约束',
        comparison: '比较',
        verification: '验证',
        contradiction: '反证',
        reference: '参考'
      } as Record<string, string>
    )[value] || value
  );
}

export function short(value?: string | null) {
  return value ? value.slice(0, 12) : '待绑定';
}
