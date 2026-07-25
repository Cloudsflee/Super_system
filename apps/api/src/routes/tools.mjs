import { HttpError, command, makeRoute, send } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { ToolType, createTool, maskSecretsDeep, pick, now } from '../../../../packages/shared/index.mjs';

export const toolRoutes = [
  makeRoute('GET', '/tools', async ({ res }) => send(res, 200, (await readState()).tools)),
  makeRoute('POST', '/tools', createRoute),
  makeRoute('PUT', '/tools/:id', updateRoute),
  makeRoute('POST', '/tools/:id/health', healthRoute)
];

async function createRoute({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      tool = createTool({ ...body, type: body.type || ToolType.Cli, created_by_user_id: actor.id });
    state.tools.push(tool);
    addTrace(
      state,
      'human.reviewed',
      { target_type: 'tool', target_id: tool.id, summary: `创建工具：${tool.name}` },
      actor.id
    );
    return tool;
  });
  return send(res, 201, result);
}

async function updateRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const tool = findTool(state, params.id);
    Object.assign(
      tool,
      maskSecretsDeep(
        pick(body, [
          'name',
          'type',
          'description',
          'config',
          'enabled',
          'capabilities',
          'permissions',
          'usage_boundary'
        ])
      ),
      { updated_at: now() }
    );
    return tool;
  });
  return send(res, 200, result);
}

async function healthRoute({ res, params }) {
  const state = await readState(),
    current = findTool(state, params.id);
  const status = await probeTool(current);
  const result = await mutate((data) => {
    const actor = owner(data),
      tool = findTool(data, params.id);
    Object.assign(tool, {
      health_status: status.ok ? 'healthy' : 'unhealthy',
      health_log: `${status.stdout || ''}\n${status.stderr || status.error || ''}`.trim(),
      discovered_tools: status.discovered_tools || tool.discovered_tools || [],
      last_checked_at: now(),
      updated_at: now()
    });
    addTrace(
      data,
      'tool.health.checked',
      {
        target_type: 'tool',
        target_id: tool.id,
        summary: `工具健康检查：${tool.name} → ${tool.health_status}`,
        data: status
      },
      actor.id
    );
    return tool;
  });
  return send(res, 200, result);
}

async function probeTool(tool) {
  if (tool.type === ToolType.BuiltIn) return { ok: true, stdout: 'built-in capability available', stderr: '' };
  if (tool.type === ToolType.Cli)
    return command(tool.config?.command || tool.name, tool.config?.health_args || ['--version'], ROOT, 5000);
  if (tool.type === ToolType.McpStdio) {
    if (!tool.config?.command) return { ok: false, stdout: '', stderr: 'MCP stdio command is required' };
    return command(tool.config.command, tool.config.health_args || ['--version'], tool.config.cwd || ROOT, 5000);
  }
  if (tool.type === ToolType.McpHttp) return probeMcpHttp(tool.config?.url);
  if (tool.type === ToolType.Api) return probeHttp(tool.config?.url);
  if (tool.type === ToolType.DockerCompose) return command('docker', ['compose', 'version'], ROOT, 5000);
  return { ok: false, stdout: '', stderr: `unsupported tool type: ${tool.type}` };
}

async function probeHttp(url) {
  if (!url) return { ok: false, stdout: '', stderr: 'URL is required' };
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    return { ok: response.ok, stdout: `HTTP ${response.status}`, stderr: response.ok ? '' : response.statusText };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error.message };
  }
}

async function probeMcpHttp(url) {
  if (!url) return { ok: false, stdout: '', stderr: 'MCP URL is required' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ai-workspace', version: '1.2' }
        }
      }),
      signal: AbortSignal.timeout(5000)
    });
    const payload = await response.json();
    return {
      ok: response.ok && !payload.error,
      stdout: JSON.stringify({
        protocolVersion: payload.result?.protocolVersion,
        serverInfo: payload.result?.serverInfo
      }),
      stderr: payload.error?.message || '',
      discovered_tools: []
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error.message };
  }
}

function findTool(state, idValue) {
  const tool = state.tools.find((item) => item.id === idValue);
  if (!tool) throw new HttpError(404, { error: 'tool_not_found' });
  return tool;
}
