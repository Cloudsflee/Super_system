import { ToolType } from './enums.mjs';
import { now, slugify } from './utils.mjs';

export function createTool({
  name,
  type = ToolType.Cli,
  description = '',
  config = {},
  enabled = true,
  capabilities = [],
  created_by_user_id
}) {
  const created = now();
  return {
    id: `tool_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    name,
    type,
    description,
    config,
    enabled,
    capabilities: capabilities.length ? capabilities : defaultCapabilitiesForTool(name, type),
    permissions: { workspace_only: true, secrets: 'env_ref_only' },
    usage_boundary: '仅在项目 workspace root 和 Node Contract allowed_tools 范围内使用。',
    health_status: 'unknown',
    health_log: '',
    discovered_tools: [],
    created_by_user_id,
    created_at: created,
    updated_at: created,
    last_checked_at: null
  };
}

function defaultCapabilitiesForTool(name, type) {
  const lower = `${name} ${type}`.toLowerCase();
  if (lower.includes('git')) return ['git', 'diff', 'commit'];
  if (lower.includes('codex')) return ['codex_runner', 'assist'];
  if (lower.includes('filesystem') || lower.includes('file')) return ['filesystem'];
  if (lower.includes('mcp')) return ['mcp'];
  return [slugify(name, 'tool')];
}

export function defaultTools(actorId) {
  return [
    createTool({
      name: 'filesystem',
      type: ToolType.BuiltIn,
      description: '受 workspace root 白名单约束的本地文件系统访问。',
      capabilities: ['filesystem'],
      created_by_user_id: actorId
    }),
    createTool({
      name: 'git',
      type: ToolType.BuiltIn,
      description: '本地 git diff / branch / commit。',
      capabilities: ['git', 'diff', 'commit'],
      created_by_user_id: actorId
    }),
    createTool({
      name: 'codex_runner',
      type: ToolType.Cli,
      description: '宿主机 Codex CLI Adapter。',
      config: { command: 'codex' },
      capabilities: ['codex_runner', 'assist'],
      created_by_user_id: actorId
    }),
    createTool({
      name: 'github_pr_provider',
      type: ToolType.Api,
      description: 'GitHub PR 创建，可选绑定 token/env ref。',
      capabilities: ['github_pr'],
      created_by_user_id: actorId
    })
  ];
}
