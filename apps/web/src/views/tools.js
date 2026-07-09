import { state } from '../state.js';
import { card, esc, status } from '../ui.js';

export function toolsView() {
  return `
    <div class="grid cols-2">
      <form id="tool-form" class="card stack"><h3>新增工具 / MCP</h3><label>名称</label><input name="name" value="demo_http_mcp" /><label>类型</label><select name="type"><option value="cli">CLI</option><option value="mcp_http">HTTP MCP</option><option value="mcp_stdio">stdio MCP</option><option value="docker_compose">Docker Compose MCP</option></select><label>描述</label><textarea name="description">用于演示 Tool Registry 健康检查与 Context Pack 注入。</textarea><button class="primary">创建工具</button></form>
      ${card('工具列表', (state.tools || []).map((tool) => `<div class="card soft"><div class="row between"><b>${esc(tool.name)}</b>${status(tool.health_status)}</div><p>${esc(tool.type)} · ${esc(tool.description)}</p><button class="tool-health secondary" data-id="${tool.id}">Health Check</button></div>`).join(''))}
    </div>`;
}
