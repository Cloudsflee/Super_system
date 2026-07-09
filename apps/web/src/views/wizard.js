import { state } from '../state.js';
import { card, empty, esc } from '../ui.js';

export function wizardView() {
  return `
    <form id="project-form" class="card stack">
      <h3>创建 Project Workspace</h3>
      <label>标题</label><input name="title" value="AI Workspace System 自身功能开发" />
      <label>目标</label><textarea name="goal" rows="3">实现 Tool Registry 基础 CRUD，并跑通 Context Pack、Trace、Asset、Digest、Git Review 闭环。</textarea>
      <label>角色</label><input name="role" value="毕业设计演示开发者" />
      <label>背景</label><textarea name="background" rows="3">证明 Codex 能在可追溯、可接续、可资产化的工作空间中完成任务。</textarea>
      <label>Repo / Workspace Root</label><input name="repo_path" value="${esc(location.pathname ? '' : '')}" placeholder="可留空，后续在 Git Review 绑定" />
      <div class="row"><button class="primary">创建项目</button><button type="button" id="wizard-assist" class="secondary">让 Codex 帮我澄清</button></div>
    </form>
    <div style="height:16px"></div>
    ${state.project ? card('当前项目', `<b>${esc(state.project.project.title)}</b><p>${esc(state.project.project.goal)}</p>`) : empty('还没有项目，创建后可推荐工作流。')}`;
}
