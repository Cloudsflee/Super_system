import { api, json } from '../../api/client';
import type { AssistV3Session } from '../../api/types';
import { describeAssistSurface } from '../../components/assist/semantic-actions';
import { reasoningEffortLabel } from '../../components/common/display-labels';
import { assistKeys } from './assist-api';
import type { AssistActionContext } from './assist-controller-support';

export function useAssistSessionActions(context: AssistActionContext) {
  const { input, state, data, tasks, toast } = context;
  function selectModel(value: string) {
    state.setModelState(value);
    const entry = data.models.data?.models?.find((item) => item.model === value);
    if (!entry) return;
    const efforts = entry.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    if (!efforts.includes(state.reasoning)) {
      const fallback = entry.defaultReasoningEffort || efforts[0] || '';
      state.setReasoning(fallback);
      if (fallback) toast(`模型 ${value} 使用默认推理强度：${reasoningEffortLabel(fallback)}`);
    }
  }
  function selectConfiguration(value: string) {
    const item = data.configurations.data?.find((entry) => entry.id === value);
    if (!item) return;
    state.setConfigurationId(item.id);
    state.setModelState(item.model);
    state.setReasoning(item.reasoning);
  }
  const createScopedSession = () => createScopedAssistSession(context);
  async function resolveSubmitSession() {
    return resolveExistingSession(context, createScopedSession);
  }
  function createSession() {
    if (!input.projectId) {
      toast('请先创建或选择项目，再新建智能助手线程。', 'error');
      return;
    }
    void tasks.perform(async () => {
      const created = await createScopedSession();
      await tasks.refresh(created.id);
    });
  }
  function showArchived(value: boolean) {
    state.pendingSelectionId.current = null;
    state.setArchived(value);
    state.setSelectedId(undefined);
    state.setView('chat');
    state.setReviewTarget(null);
  }
  const itemActions = sessionItemActions(context);
  return {
    selectModel,
    selectConfiguration,
    resolveSubmitSession,
    createSession,
    showArchived,
    ...itemActions
  };
}

function sessionItemActions(context: AssistActionContext) {
  const { state, tasks } = context;
  function rename(item: AssistV3Session) {
    const title = window.prompt('重命名线程', item.title)?.trim();
    if (!title || title === item.title) return;
    void tasks.perform(async () => {
      await api(`/assist/v3/sessions/${item.id}/rename`, json('POST', { title }, '重命名智能助手线程'));
      await tasks.refresh(item.id);
    });
  }
  function pin(item: AssistV3Session) {
    void tasks.perform(async () => {
      await api(
        `/assist/v3/sessions/${item.id}/pin`,
        json('POST', { pinned: !item.pinned }, item.pinned ? '取消置顶智能助手线程' : '置顶智能助手线程')
      );
      await tasks.refresh(item.id);
    });
  }
  function archive(item: AssistV3Session) {
    void tasks.perform(async () => {
      await api(
        `/assist/v3/sessions/${item.id}/${state.archived ? 'restore' : 'archive'}`,
        json('POST', undefined, state.archived ? '恢复智能助手线程' : '归档智能助手线程')
      );
      if (state.archived) {
        state.setArchived(false);
        state.setSelectedId(item.id);
      } else if (state.selectedId === item.id) state.setSelectedId(undefined);
      await tasks.refresh(item.id);
    });
  }
  function fork(item: AssistV3Session) {
    void tasks.perform(async () => {
      const created = await api<AssistV3Session>(
        `/assist/v3/sessions/${item.id}/fork`,
        json('POST', { title: `${item.title} · 分支` }, '创建智能助手线程分支')
      );
      state.setSelectedId(created.id);
      state.setView('chat');
      await tasks.refresh(created.id);
    });
  }
  function deleteBranch(item: AssistV3Session) {
    void tasks.perform(async () => {
      await api(`/assist/v3/sessions/${item.id}`, json('DELETE', undefined, '删除智能助手线程'));
      if (state.selectedId === item.id) state.setSelectedId(undefined);
      await tasks.refresh();
    });
  }
  function restoreDeleted(item: AssistV3Session) {
    void tasks.perform(async () => {
      await api(`/assist/v3/sessions/${item.id}/restore-deleted`, json('POST', undefined, '恢复已删除智能助手线程'));
      state.setSelectedId(item.id);
      await tasks.refresh(item.id);
    });
  }
  return { rename, pin, archive, fork, deleteBranch, restoreDeleted };
}

export type AssistSessionActions = ReturnType<typeof useAssistSessionActions>;

async function createScopedAssistSession({ input, state }: AssistActionContext) {
  if (!input.projectId || !input.scopeType || !input.scopeId) throw new Error('当前页面没有可用的智能助手作用域。');
  const label = { project: '项目', workflow: '工作流', workstream: '成果节点', task: '任务' }[input.scopeType],
    surface = describeAssistSurface(),
    created = await api<AssistV3Session>(
      '/assist/v3/sessions',
      json(
        'POST',
        {
          project_id: input.projectId,
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          title: `${label}智能助手`,
          repository_workspace_id: surface.repository_workspace_id || undefined,
          view_context: {
            route: input.route,
            project_id: input.projectId,
            scope_type: input.scopeType,
            scope_id: input.scopeId,
            repository_workspace_id: surface.repository_workspace_id,
            surface
          }
        },
        '创建智能助手线程'
      )
    );
  state.pendingSelectionId.current = created.id;
  state.setArchived(false);
  state.setSelectedId(created.id);
  state.setView('chat');
  return created;
}

async function resolveExistingSession(
  context: AssistActionContext,
  createScopedSession: () => Promise<AssistV3Session>
) {
  const { input, state, data, client } = context;
  if (currentSessionMatchesScope(context)) return data.session!;
  const existingId = state.archived
    ? undefined
    : (data.sessions.data || []).find(
        (item) =>
          !item.deleted_at &&
          !item.archived_at &&
          !item.read_only &&
          (!item.scope_status || item.scope_status === 'active')
      )?.id;
  if (!existingId) return createScopedSession();
  const existing = await api<AssistV3Session>(`/assist/v3/sessions/${existingId}`);
  state.pendingSelectionId.current = existing.id;
  state.setSelectedId(existing.id);
  client.setQueryData(assistKeys.session(existing.id), existing);
  return existing;
}

function currentSessionMatchesScope({ input, data }: AssistActionContext) {
  return Boolean(
    data.session &&
    !data.session.archived_at &&
    data.session.project_id === input.projectId &&
    data.session.scope_type === input.scopeType &&
    data.session.scope_id === input.scopeId &&
    data.session.scope_status !== 'invalidated'
  );
}
