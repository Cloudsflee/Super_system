import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function prepareDraftBrief(api, projectId) {
  return api(`/projects/${projectId}/intake`, 'PUT', { mode: 'brainstorm', answers: { goal: '交付可验证的 V1.7 工作空间', users: ['本地项目负责人'], features: ['Assist 协作', 'Brief V2 编辑', '工作流草稿'], constraints: ['本地优先', '变更可撤销'], milestones: ['完成 V1.7 验收'], acceptance_criteria: ['桌面与移动端均无溢出'], risks: ['迁移失败时恢复 V1.6'], open_questions: ['正式模板来源'] } });
}

export function seedV17AssistVisualState({ stateFile, assistSessionId, visualTurnId }) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')), at = new Date(0).toISOString();
  const rootSession = state.assist_sessions.find((item) => item.id === assistSessionId);
  rootSession.native_goal_snapshot = { objective: 'Ship V1.7', status: 'active', tokenBudget: 99999, tokensUsed: 42000, timeUsedSeconds: 3600 };
  state.assist_sessions.push({ ...rootSession, id: 'asst_e2e_deleted_branch', title: 'Deleted visual branch', parent_session_id: assistSessionId, forked_from_session_id: assistSessionId, forked_from_turn_id: visualTurnId, codex_thread_id: null, pinned: false, lifecycle: 'deleted', delete_batch_id: 'adel_e2e_visual', deleted_at: at, purge_after: new Date(Date.now() + 86400000).toISOString() });
  state.runtime_user_inputs.push({ id: 'rui_e2e_v17', session_id: assistSessionId, turn_id: visualTurnId, item_id: 'scope-question', status: 'pending', contains_secret: false, questions: [{ id: 'scope', header: '范围确认', question: '采用哪个交付范围？', isOther: true, allow_note: true, options: [{ label: '安全范围', description: '保留回滚路径并先完成可逆改动', recommended: true }, { label: '完整范围', description: '一次完成所有候选改动', recommended: false }] }], created_at: at, updated_at: at });
  state.assist_operations.push({ id: 'aop_e2e_v17', session_id: assistSessionId, turn_id: visualTurnId, tool_call_id: 'call-e2e-v17', tool: 'aiws_page.set_field', project_id: rootSession.project_id, capability_id: 'surface.field.set', action: 'set', route: `/projects/${rootSession.project_id}/workflow`, surface_id: 'workflow', surface_revision: 'e2e-r1', browser_instance_id: null, target_id: 'brief.goal', target_label: '核心目标', summary: '已更新 · 核心目标', input_schema: { type: 'object' }, locator: { route: `/projects/${rootSession.project_id}/workflow`, project_id: rootSession.project_id, surface_id: 'workflow', surface_revision: 'e2e-r1', target_id: 'brief.goal', target_label: '核心目标' }, requested_value: null, allowed_values: null, before_value: '旧目标', after_value: '交付 V1.7', current_value: '交付 V1.7', before_hash: 'before-e2e', after_hash: 'after-e2e', current_hash: 'after-e2e', status: 'committed', risk: 'low', revision: 2, inverse_of: null, forced: false, conflict: null, committed_at: at, created_at: at, updated_at: at });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export async function captureBriefWorkspace(page, { output, viewport, assertViewport }) {
  const workspace = page.locator('.brief-workspace'); await workspace.waitFor(); await assertViewport(page);
  await page.screenshot({ path: path.join(output, `brief-editor-${viewport.name}.png`), fullPage: true });
  if (viewport.width > 620) return;
  const tabs = page.getByRole('navigation', { name: '简报工作区视图' }); assert.equal(await tabs.getByRole('button').count(), 3);
  await tabs.getByRole('button', { name: '大纲' }).click(); assert.equal(await page.locator('.brief-outline.mobile-active').count(), 1); await assertViewport(page); await page.screenshot({ path: path.join(output, 'brief-outline-mobile.png'), fullPage: true });
  await tabs.getByRole('button', { name: '工作流' }).click(); assert.equal(await page.locator('.workflow-draft-panel.mobile-active').count(), 1); await assertViewport(page); await page.screenshot({ path: path.join(output, 'brief-workflow-mobile.png'), fullPage: true });
  await tabs.getByRole('button', { name: '简报' }).click(); assert.equal(await page.locator('.brief-document.mobile-active').count(), 1);
}
