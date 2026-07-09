import { get, post, put } from './src/api.js';
import { currentNode, setState, state } from './src/state.js';
import { $, bindClick, formData, toast } from './src/ui.js';
import { bindShortcuts, syncActiveNav, withBusy } from './src/shell.js';
import { assistPayload, infoChip, renderOptions, renderQuestions } from './src/assist-ui.js';
import { dashboardView } from './src/views/dashboard.js';
import { wizardView } from './src/views/wizard.js';
import { workflowView } from './src/views/workflow.js';
import { nodeView } from './src/views/node.js';
import { contextView } from './src/views/context.js';
import { runnerView } from './src/views/runner.js';
import { assetsView } from './src/views/assets.js';
import { gitView } from './src/views/git.js';
import { toolsView } from './src/views/tools.js';
import { reviewView } from './src/views/review.js';

const views = { dashboard: dashboardView, wizard: wizardView, workflow: workflowView, node: nodeView, context: contextView, runner: runnerView, assets: assetsView, git: gitView, tools: toolsView, review: reviewView };
const titles = { dashboard: '总览', wizard: 'Project Wizard', workflow: 'Workflow Canvas', node: 'Node Workspace', context: 'Context Pack Preview', runner: 'Runner / Trace', assets: 'Asset / Digest', git: 'Git / PR', tools: 'Tool Registry', review: '复盘' };

async function loadBase() {
  const [health, me, projects, review, tools, githubStatus, codexStatus, ccSwitchStatus, codexProfiles, changeProposals, agentSessions] = await Promise.all([
    get('/health'), get('/account/me'), get('/projects'), get('/review'), get('/tools'),
    get('/integrations/github/status'), get('/integrations/codex/status'), get('/integrations/cc-switch/status'), get('/codex/profiles'), get('/change-proposals'), get('/agent-sessions')
  ]);
  setState({ health, me, projects, review, tools, githubStatus, codexStatus, ccSwitchStatus, codexProfiles, changeProposals, agentSessions });
  const selectedId = $('#project-select').value || projects.at(-1)?.id;
  if (selectedId) await loadProject(selectedId);
  updateShell();
}

async function loadProject(id) {
  const project = await get(`/projects/${id}`);
  const firstNode = project.nodes?.[0]?.id || null;
  setState({ project, selectedNodeId: state.selectedNodeId || firstNode });
  const node = currentNode();
  if (node?.workspace_id) await loadWorkspace(node.workspace_id);
}

async function loadWorkspace(id) { setState({ workspace: await get(`/workspaces/${id}`) }); }
function render() { $('#view-title').textContent = titles[state.view]; $('#view').innerHTML = views[state.view](); bindViewEvents(); }
function updateShell() { updateHealth(); updateProjectSelect(); render(); syncActiveNav(state.view); }
function updateHealth() { const pill = $('#health-pill'); pill.textContent = state.health?.status === 'ok' ? 'health: ok' : 'health: degraded'; pill.className = `pill ${state.health?.status === 'ok' ? 'ok' : 'warn'}`; }
function updateProjectSelect() { const sel = $('#project-select'); sel.innerHTML = `<option value="">选择 Project</option>${state.projects.map((p) => `<option value="${p.id}">${p.title}</option>`).join('')}`; if (state.project) sel.value = state.project.project.id; }

function bindGlobal() {
  document.querySelectorAll('#nav button').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $('#refresh-btn').onclick = () => withBusy('刷新工作空间...', () => loadBase().then(() => toast('已刷新')));
  $('#project-select').onchange = (event) => event.target.value && withBusy('加载 Project...', () => loadProject(event.target.value).then(render));
  $('#demo-chain-btn').onclick = () => withBusy('生成完整演示证据链...', () => post('/demo/full-chain').then(loadBase).then(() => toast('演示链路已生成')));
  $('#assist-open-btn').onclick = () => openAssist();
  $('#assist-close-btn').onclick = () => $('#assist-panel').classList.remove('open');
  $('#assist-run-btn').onclick = () => withBusy('Codex Assist 正在生成建议...', runAssist);
  $('#shortcut-btn').onclick = () => document.querySelector('#shortcut-panel')?.classList.toggle('show');
  $('#sidebar-toggle').onclick = () => $('#app-shell').classList.toggle('sidebar-collapsed');
  $('#approval-close-btn').onclick = () => $('#approval-panel').classList.remove('open');
  bindShortcuts({ setView: switchView, openAssist: () => openAssist(), refresh: () => withBusy('刷新工作空间...', loadBase) });
}

function switchView(view) { setState({ view }); syncActiveNav(view); render(); }

function bindViewEvents() {
  const root = $('#view');
  $('#project-form', root)?.addEventListener('submit', createProject);
  $('#wizard-assist', root)?.addEventListener('click', () => openAssist('project_wizard'));
  $('#recommend-workflow', root)?.addEventListener('click', recommendWorkflow);
  $('#confirm-workflow', root)?.addEventListener('click', confirmWorkflow);
  bindClick(root, '.flow-node', (e) => state.view === 'workflow' ? selectWorkflowNode(e.currentTarget.dataset.nodeId) : selectNode(e.currentTarget.dataset.nodeId));
  $('#select-node-workspace', root)?.addEventListener('click', () => currentNode()?.workspace_id && loadWorkspace(currentNode().workspace_id).then(() => toast('Node Workspace 已加载')));
  $('#contract-assist', root)?.addEventListener('click', () => openAssist('node_contract'));
  $('#confirm-contract', root)?.addEventListener('click', confirmContract);
  $('#preview-context', root)?.addEventListener('click', previewContext);
  $('#confirm-context', root)?.addEventListener('click', confirmContext);
  $('#start-run', root)?.addEventListener('click', startRun);
  $('#load-run-trace', root)?.addEventListener('click', loadTrace);
  $('#cancel-run', root)?.addEventListener('click', cancelRun);
  bindClick(root, '.select-run', (e) => selectRun(e.currentTarget.dataset.runId));
  bindClick(root, '.confirm-asset', (e) => post(`/asset-candidates/${e.currentTarget.dataset.id}/confirm`).then(refreshWorkspace));
  bindClick(root, '.reject-asset', (e) => post(`/asset-candidates/${e.currentTarget.dataset.id}/reject`).then(refreshWorkspace));
  $('#generate-digest', root)?.addEventListener('click', generateDigest);
  $('#bind-repo', root)?.addEventListener('click', bindRepo);
  $('#git-branch', root)?.addEventListener('click', gitBranch);
  $('#git-diff', root)?.addEventListener('click', gitDiff);
  $('#git-commit', root)?.addEventListener('click', gitCommit);
  $('#github-pr', root)?.addEventListener('click', githubPr);
  $('#tool-form', root)?.addEventListener('submit', createTool);
  bindClick(root, '.tool-health', (e) => post(`/tools/${e.currentTarget.dataset.id}/health`).then(loadBase));
  $('#github-oauth-start', root)?.addEventListener('click', startGithubOAuth);
  $('#codex-docker-build', root)?.addEventListener('click', () => withBusy('检查/构建 Codex Docker...', () => post('/integrations/codex/docker/build', { mock: true }).then(loadBase)));
  $('#cc-switch-sync', root)?.addEventListener('click', () => withBusy('同步 cc-switch...', () => post('/integrations/cc-switch/sync', { dry_run: true }).then(loadBase)));
  $('#workflow-enter-node', root)?.addEventListener('click', () => selectNode(state.selectedWorkflowNodeId || currentNode()?.id));
  $('#workflow-node-proposal', root)?.addEventListener('click', createWorkflowProposal);
  $('#workflow-zoom-in', root)?.addEventListener('click', () => zoomWorkflow(0.1));
  $('#workflow-zoom-out', root)?.addEventListener('click', () => zoomWorkflow(-0.1));
  $('#workflow-reset', root)?.addEventListener('click', () => { setState({ workflowViewport: { x: 0, y: 0, scale: 1 } }); render(); });
  bindWorkflowCanvas(root);
}

async function createProject(e) { e.preventDefault(); return withBusy('创建 Project...', async () => { const created = await post('/projects', formData(e.currentTarget)); await loadProject(created.project.id); await loadBase(); setState({ view: 'workflow' }); toast('Project 已创建'); }); }
async function recommendWorkflow() { return withBusy('推荐 5 节点工作流...', async () => { await post('/workflows/recommend', { project_id: state.project.project.id }); await loadProject(state.project.project.id); toast('已推荐工作流'); render(); }); }
async function confirmWorkflow() { return withBusy('确认工作流并创建节点契约...', async () => { const wf = state.project.workflows.at(-1); await post(`/workflows/${wf.id}/confirm`); await loadProject(state.project.project.id); toast('工作流与节点契约已确认'); render(); }); }
async function selectNode(id) { setState({ selectedNodeId: id, view: 'node' }); const node = currentNode(); if (node?.workspace_id) await loadWorkspace(node.workspace_id); render(); }
function selectWorkflowNode(id) { setState({ selectedWorkflowNodeId: id, selectedNodeId: id }); render(); }
function zoomWorkflow(delta) { const v = state.workflowViewport; setState({ workflowViewport: { ...v, scale: Math.max(.6, Math.min(1.8, Number(v.scale || 1) + delta)) } }); render(); }
function bindWorkflowCanvas(root) {
  const canvas = $('#workflow-canvas', root); if (!canvas) return;
  let start = null;
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomWorkflow(e.deltaY > 0 ? -.08 : .08); }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => { if (e.target.closest('.flow-node')) return; start = { x: e.clientX, y: e.clientY, v: { ...state.workflowViewport } }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', (e) => { if (!start) return; setState({ workflowViewport: { ...start.v, x: start.v.x + e.clientX - start.x, y: start.v.y + e.clientY - start.y } }); $('#workflow-stage', root).style.transform = `translate(${state.workflowViewport.x}px, ${state.workflowViewport.y}px) scale(${state.workflowViewport.scale})`; });
  canvas.addEventListener('pointerup', () => { start = null; canvas.classList.remove('dragging'); });
}
async function confirmContract() {
  const node = currentNode();
  const criteria = ($('#contract-criteria')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const tools = ($('#contract-tools')?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
  const proposal = await post('/change-proposals', {
    project_id: state.project.project.id,
    workspace_id: node.workspace_id,
    node_id: node.id,
    change_type: 'node_contract_patch',
    title: '保存 Node Contract 前的本质变更审批',
    summary: 'Node Contract 会改变后续 Context Pack、工具权限和 Runner 行为，需用户批准后应用。',
    before: currentNode(),
    after: { node_goal: $('#contract-goal')?.value || node.goal, acceptance_criteria: criteria.length ? criteria : ['质量自检通过', 'Trace 可追溯', '资产需人工确认'], allowed_tools: tools.length ? tools : ['filesystem', 'git', 'mock_runner'] },
    impact: ['Node Contract', 'Context Pack', 'allowed_tools'],
    risks: ['错误工具权限可能影响后续执行范围'],
    apply_action: { type: 'node_contract_patch' }
  });
  await loadBase();
  openApproval(proposal);
}
async function previewContext() { return withBusy('构建 Context Pack 与 Memory Manifest...', async () => { const node = currentNode(); const ctx = await post(`/nodes/${node.id}/context-pack/preview`, {}); setState({ lastContextPack: ctx, selectedContextPackId: ctx.id }); toast('Context Pack Preview 已生成'); render(); }); }
async function confirmContext() { const id = state.selectedContextPackId || state.lastContextPack?.id; const result = await post(`/context-packs/${id}/confirm`); setState({ lastContextPack: result.context_pack }); await refreshWorkspace(); toast('Context Pack 已落盘'); }
async function startRun() {
  const node = currentNode();
  const runner = $('#runner-kind')?.value || 'mock';
  const forceMock = runner === 'codex' ? !$('#runner-live')?.checked : true;
  const writeCapable = $('#runner-mock-write')?.checked !== false || runner !== 'mock';
  if (writeCapable && !hasAppliedRunApproval(node?.id, runner)) return proposeRunApproval(node, runner);
  const result = await post(`/nodes/${node.id}/run`, { runner, force_mock: forceMock, mock_write: $('#runner-mock-write')?.checked !== false });
  setState({ selectedRun: result.run, selectedRunId: result.run.id });
  await refreshWorkspace();
  setState({ view: 'runner' });
  toast(`NodeRun ${result.run.status}`);
}
function hasAppliedRunApproval(nodeId, runner) { return (state.changeProposals || []).some((p) => p.node_id === nodeId && p.change_type === 'node_run_write' && p.status === 'applied' && p.after_json?.runner === runner); }
async function proposeRunApproval(node, runner) {
  const proposal = await post('/change-proposals', { project_id: state.project.project.id, workspace_id: node.workspace_id, node_id: node.id, change_type: 'node_run_write', title: '启动写入型 NodeRun 前的审批', summary: `Runner ${runner} 可能写入文件或调用 Codex/Docker，需批准后执行。批准后请再次点击启动 NodeRun。`, before: { node_status: node.status }, after: { runner, mock_write: $('#runner-mock-write')?.checked !== false }, impact: ['NodeRun', 'File changes', 'Trace'], risks: ['可能产生文件变化或外部工具调用'], apply_action: { type: 'record_only' } });
  await loadBase();
  openApproval(proposal);
  return null;
}
async function selectRun(id) { setState({ selectedRunId: id, selectedRun: await get(`/runs/${id}`).then((x) => x.run), runTrace: await get(`/runs/${id}/trace`) }); render(); }
async function cancelRun() { if (!state.selectedRunId) return toast('请先选择 Run', 'error'); const run = await post(`/runs/${state.selectedRunId}/cancel`, {}); setState({ selectedRun: run }); await refreshWorkspace(); toast('取消请求已记录'); }

async function loadTrace() { if (!state.selectedRunId) return; setState({ runTrace: await get(`/runs/${state.selectedRunId}/trace`) }); render(); }
async function refreshWorkspace() { const node = currentNode(); if (node?.workspace_id) await loadWorkspace(node.workspace_id); setState({ review: await get('/review') }); render(); }
async function generateDigest() { await post(`/workspaces/${state.workspace.workspace.id}/digests`, {}); await refreshWorkspace(); toast('Digest 已生成'); }
async function bindRepo() { await post(`/projects/${state.project.project.id}/git-repositories`, { local_path: $('#repo-path').value }); await loadProject(state.project.project.id); toast('Repo 已绑定'); }
async function gitBranch() { const run = state.selectedRun || state.review?.runs?.at(-1); await post(`/runs/${run.id}/git/branch`); await loadBase(); toast('分支处理完成'); }
async function gitDiff() { const run = state.selectedRun || state.review?.runs?.at(-1); await post(`/runs/${run.id}/git/diff`); await loadBase(); toast('Diff 已捕获'); }
async function gitCommit() { const run = state.selectedRun || state.review?.runs?.at(-1); await post(`/runs/${run.id}/git/commit`, {}); await loadBase(); toast('Commit/草稿完成'); }
async function githubPr() { const run = state.selectedRun || state.review?.runs?.at(-1); await post(`/runs/${run.id}/github/pr`, {}); await loadBase(); toast('PR 或草稿已生成'); }
async function createTool(e) { e.preventDefault(); return withBusy('创建工具并刷新注册表...', async () => { await post('/tools', formData(e.currentTarget)); await loadBase(); toast('工具已创建'); }); }
async function startGithubOAuth() { return withBusy('启动 GitHub OAuth...', async () => { const result = await post('/integrations/github/oauth/device/start', { mock: true }); toast(`GitHub device code: ${result.user_code}`); await post('/integrations/github/oauth/device/poll', { device_code: result.device_code, login: 'aiws-oauth-demo' }); await loadBase(); }); }
async function createWorkflowProposal() { const node = currentNode(); const proposal = await post('/change-proposals', { project_id: state.project?.project?.id, workspace_id: node?.workspace_id, node_id: node?.id, change_type: 'node_contract_patch', title: '节点本质变更说明', summary: '准备调整节点契约/上下文/执行策略，需用户确认后应用。', before: node, after: { review_policy: { human_required: true } }, impact: ['Node Contract', 'Context Pack', 'Runner'], risks: ['可能改变后续 Codex 执行上下文'], apply_action: { type: 'node_contract_patch' } }); await loadBase(); openApproval(proposal); }
function openApproval(proposal) { $('#approval-panel').classList.add('open'); $('#approval-body').innerHTML = `<div class="stack"><h3>${proposal.title}</h3><p>${proposal.summary}</p><div class="row">${infoChip('Status', proposal.status)}${infoChip('Type', proposal.change_type)}</div><pre class="code">${JSON.stringify({ before: proposal.before_json, after: proposal.after_json, impact: proposal.impact, risks: proposal.risks }, null, 2)}</pre><button id="approve-proposal" class="primary full">批准并应用</button><button id="reject-proposal" class="danger full">拒绝</button></div>`; $('#approve-proposal').onclick = () => withBusy('应用变更...', async () => { await post(`/change-proposals/${proposal.id}/approve`, {}); await post(`/change-proposals/${proposal.id}/apply`, {}); await loadBase(); $('#approval-panel').classList.remove('open'); toast('变更已批准并应用'); }); $('#reject-proposal').onclick = () => withBusy('拒绝变更...', async () => { await post(`/change-proposals/${proposal.id}/reject`, { reason: '用户在审批抽屉拒绝' }); await loadBase(); $('#approval-panel').classList.remove('open'); toast('变更已拒绝'); }); }

function openAssist(target) { $('#assist-panel').classList.add('open'); if (target) $('#assist-target').value = target; }
async function runAssist() { const target = $('#assist-target').value; const session = await post('/assist/sessions', assistPayload(target, $('#assist-prompt').value)); renderAssist(session); }
function renderAssist(session) {
  const result = session.result;
  $('#assist-result').className = 'assist-result';
  $('#assist-result').innerHTML = `<div class="assist-summary"><b>${result.summary}</b><div class="assist-chips">${infoChip('Sufficiency', result.sufficiency_check?.status || 'unknown')}${infoChip('Included', result.memory_manifest?.included?.length || 0)}${infoChip('Excluded', result.memory_manifest?.excluded?.length || 0)}</div></div>${renderQuestions(result.questions)}<div class="option-grid">${renderOptions(result.options)}</div><pre class="code">${JSON.stringify(result.draft_patch, null, 2)}</pre><button id="assist-apply" class="primary full">应用草稿</button>`;
  $('#assist-apply').onclick = async () => { await post(`/assist/sessions/${session.id}/apply`, { node_id: currentNode()?.id }); await loadBase(); toast('Assist 草稿已应用'); };
}

bindGlobal();
loadBase().catch((error) => toast(error.message, 'error'));
