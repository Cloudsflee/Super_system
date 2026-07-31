import { api, json } from '../../api/client';
import type { AssistClarificationPolicy, AssistConfiguration, AssistGoal, AssistV3Turn } from '../../api/types';
import { describeAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { activeTurn } from './assist-api';
import type { AssistActionContext, FollowUp } from './assist-controller-support';
import type { AssistSessionActions } from './assist-controller-session-actions';

export function useAssistConversationActions(context: AssistActionContext, sessions: AssistSessionActions) {
  const { state, data, client, tasks, toast } = context;
  function submit(behavior: FollowUp) {
    const content = state.prompt.trim();
    if (!content || !context.input.projectId) return;
    useUi.getState().setAssist(true);
    void tasks.perform(() => submitConversation(context, sessions, behavior, content));
  }
  function stop() {
    if (!data.running) return;
    void tasks.perform(async () => {
      await api(`/assist/v3/turns/${data.running?.id}/stop`, json('POST', { reason: 'user_stop' }, '停止智能助手处理'));
      await tasks.refresh();
    });
  }
  function retry(turn: AssistV3Turn) {
    void tasks.perform(() => retryConversationTurn(context, turn));
  }
  async function saveConfiguration(name: string) {
    tasks.beginTask();
    try {
      const created = await api<AssistConfiguration>(
        '/assist/v3/configurations',
        json(
          'POST',
          { base_profile_id: state.profileId, name, model: state.model, reasoning: state.reasoning },
          '保存智能助手配置'
        )
      );
      await client.invalidateQueries({ queryKey: ['assist-v3-configurations', state.profileId] });
      state.setConfigurationId(created.id);
      toast(`已保存配置“${created.name}”`);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error');
      return false;
    } finally {
      tasks.endTask();
    }
  }
  const goalActions = assistGoalActions(context);
  return { submit, stop, retry, saveConfiguration, ...goalActions };
}

function assistGoalActions(context: AssistActionContext) {
  const { state, data, tasks } = context;
  function setGoal(goal: Partial<AssistGoal>) {
    if (!data.session) return;
    void tasks.perform(async () => {
      await api(
        `/assist/v3/sessions/${data.session?.id}/goal`,
        json(
          'PUT',
          {
            ...goal,
            profile_id: state.profileId,
            configuration_id: state.configurationId || undefined,
            model: state.model,
            reasoning: state.reasoning
          },
          '更新智能助手目标'
        )
      );
      await tasks.refresh();
    });
  }
  function clearGoal() {
    if (!data.session) return;
    void tasks.perform(async () => {
      await api(`/assist/v3/sessions/${data.session?.id}/goal`, json('DELETE', undefined, '清除智能助手目标'));
      await tasks.refresh();
    });
  }
  function setClarificationPolicy(value: AssistClarificationPolicy) {
    if (!data.session || data.session.clarification_policy === value) return;
    void tasks.perform(async () => {
      await api(
        `/assist/v3/sessions/${data.session?.id}`,
        json('PATCH', { clarification_policy: value }, '更新智能助手澄清策略')
      );
      await tasks.refresh(data.session?.id);
    });
  }
  function respondUserInput(
    turnId: string,
    itemId: string,
    answers: Record<string, { answers: string[]; note?: string }>
  ) {
    void tasks.perform(async () => {
      await api(
        `/assist/v3/turns/${turnId}/user-input/${encodeURIComponent(itemId)}/respond`,
        json('POST', { answers }, '提交智能助手补充信息')
      );
      await tasks.refresh();
    });
  }
  return { setGoal, clearGoal, setClarificationPolicy, respondUserInput };
}

async function submitConversation(
  context: AssistActionContext,
  sessions: AssistSessionActions,
  behavior: FollowUp,
  content: string
) {
  const { input, state, data, tasks } = context,
    collaborationMode = state.planNext ? 'plan' : 'default',
    selectedAttachments = [...state.attachmentIds],
    target = await sessions.resolveSubmitSession(),
    active = activeTurn(target.turns || []) || (target.id === data.session?.id ? data.running : null),
    surface = describeAssistSurface(),
    body = {
      content,
      project_id: input.projectId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      collaboration_mode: collaborationMode,
      operation_reference_id: state.operationReferenceId || undefined,
      profile_id: state.profileId || undefined,
      configuration_id: state.configurationId || undefined,
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      repository_workspace_id: surface.repository_workspace_id || undefined,
      attachment_ids: selectedAttachments,
      view_context: {
        route: input.route,
        project_id: input.projectId,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        repository_workspace_id: surface.repository_workspace_id,
        browser_instance_id: surface.browser_instance_id,
        surface
      }
    },
    endpoint = active ? `/assist/v3/sessions/${target.id}/follow-ups` : `/assist/v3/sessions/${target.id}/turns`;
  await api<AssistV3Turn>(
    endpoint,
    json('POST', active ? { ...body, behavior } : body, active ? '发送智能助手后续消息' : '启动智能助手处理')
  );
  state.setPrompt((current) => (current.trim() === content ? '' : current));
  state.setPlanNext(false);
  state.setOperationReferenceId(null);
  await tasks.refresh(target.id);
}

async function retryConversationTurn({ input, state, tasks }: AssistActionContext, turn: AssistV3Turn) {
  const surface = describeAssistSurface();
  await api(
    `/assist/v3/turns/${turn.id}/retry`,
    json(
      'POST',
      {
        profile_id: state.profileId || turn.profile_id,
        configuration_id: state.configurationId || turn.configuration_id,
        model: state.model || turn.model,
        reasoning: state.reasoning || turn.reasoning,
        collaboration_mode: turn.collaboration_mode || 'default',
        repository_workspace_id: surface.repository_workspace_id || turn.repository_workspace_id || undefined,
        view_context: {
          route: input.route,
          repository_workspace_id: surface.repository_workspace_id,
          browser_instance_id: surface.browser_instance_id,
          surface
        }
      },
      '重试智能助手处理'
    )
  );
  await tasks.refresh();
}
