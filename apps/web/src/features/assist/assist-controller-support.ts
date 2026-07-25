import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type {
  AssistAttachment,
  AssistClarificationPolicy,
  AssistConfiguration,
  AssistGoal,
  AssistOperation,
  AssistScopeBreadcrumbItem,
  AssistScopeType,
  AssistV3Session,
  AssistV3Turn,
  TerminalSession
} from '../../api/types';
import { publishSelectionAsk } from '../../components/common/selection-ask';
import { reasoningEffortLabel } from '../../components/common/display-labels';
import { describeAssistSurface, executeAssistOperation } from '../../components/assist/semantic-actions';
import { useUi, type UiState } from '../../state/ui';
import {
  activeTurn,
  assistKeys,
  useAssistConfigurations,
  useAssistEvents,
  useAssistGoal,
  useAssistModels,
  useAssistOperations,
  useAssistSession,
  useAssistSessions,
  useCodexProfiles,
  useTerminalCapabilities
} from './assist-api';
import type { AssistCommand } from './composer-support';
import type { ReviewTarget } from './DiffReviewPanel';

export type FollowUp = 'queue' | 'steer' | 'interrupt';
export type TerminalRuntime = 'linux_container' | 'windows_bridge' | 'host_dev';
export type AssistControllerInput = {
  projectId?: string;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb: AssistScopeBreadcrumbItem[];
  enabled: boolean;
  route: string;
};

type Toast = UiState['toast'];

export function useAssistControllerState() {
  const [search, setSearch] = useState(''),
    [archived, setArchived] = useState(false),
    [selectedId, setSelectedId] = useState<string>();
  const [planNext, setPlanNext] = useState(false),
    [profileId, setProfileId] = useState(''),
    [configurationId, setConfigurationId] = useState('');
  const [model, setModelState] = useState(''),
    [reasoning, setReasoning] = useState(''),
    [prompt, setPrompt] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const pendingTasks = useRef(0),
    pendingSelectionId = useRef<string | null>(null),
    processedOperations = useRef(new Set<string>()),
    synchronizedOperations = useRef(new Set<string>()),
    synchronizedProposalEvents = useRef(new Set<string>());
  const [operationReferenceId, setOperationReferenceId] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'review' | 'terminal'>('chat'),
    [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [terminal, setTerminal] = useState<TerminalSession | null>(null),
    [terminalRolledBack, setTerminalRolledBack] = useState(false),
    [terminalSelectorOpen, setTerminalSelectorOpen] = useState(false);

  return {
    search,
    setSearch,
    archived,
    setArchived,
    selectedId,
    setSelectedId,
    planNext,
    setPlanNext,
    profileId,
    setProfileId,
    configurationId,
    setConfigurationId,
    model,
    setModelState,
    reasoning,
    setReasoning,
    prompt,
    setPrompt,
    attachmentIds,
    setAttachmentIds,
    busy,
    setBusy,
    pendingTasks,
    pendingSelectionId,
    operationReferenceId,
    setOperationReferenceId,
    view,
    setView,
    reviewTarget,
    setReviewTarget,
    terminal,
    setTerminal,
    terminalRolledBack,
    setTerminalRolledBack,
    terminalSelectorOpen,
    setTerminalSelectorOpen,
    processedOperations,
    synchronizedOperations,
    synchronizedProposalEvents
  };
}

export type AssistControllerState = ReturnType<typeof useAssistControllerState>;

export function useAssistControllerData(input: AssistControllerInput, state: AssistControllerState) {
  const sessions = useAssistSessions(
      input.projectId,
      input.scopeType,
      input.scopeId,
      state.search,
      state.archived,
      input.enabled
    ),
    detail = useAssistSession(state.selectedId, input.enabled);
  const profiles = useCodexProfiles(input.enabled),
    models = useAssistModels(state.profileId, input.enabled),
    configurations = useAssistConfigurations(state.profileId, input.enabled);
  const stream = useAssistEvents(state.selectedId, input.enabled && !state.archived),
    goal = useAssistGoal(state.selectedId, input.enabled && !state.archived),
    operations = useAssistOperations(state.selectedId, input.enabled && !state.archived),
    terminalCapabilities = useTerminalCapabilities(input.enabled);
  const session = detail.data,
    turns = session?.turns || [],
    running = activeTurn(turns);
  return {
    sessions,
    detail,
    profiles,
    models,
    configurations,
    stream,
    goal,
    operations,
    terminalCapabilities,
    session,
    turns,
    running
  };
}

export type AssistControllerData = ReturnType<typeof useAssistControllerData>;

export function useAssistTasks(client: QueryClient, toast: Toast, state: AssistControllerState) {
  function beginTask() {
    state.pendingTasks.current += 1;
    state.setBusy(true);
  }
  function endTask() {
    state.pendingTasks.current = Math.max(0, state.pendingTasks.current - 1);
    if (!state.pendingTasks.current) state.setBusy(false);
  }
  async function perform(operation: () => Promise<void>) {
    beginTask();
    try {
      await operation();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      endTask();
    }
  }
  async function refresh(sessionId = state.selectedId) {
    await client.invalidateQueries({ queryKey: ['assist-v3-sessions'] });
    if (sessionId) {
      await client.invalidateQueries({ queryKey: assistKeys.session(sessionId) });
      await client.invalidateQueries({ queryKey: ['assist-v3-goal', sessionId] });
      await client.invalidateQueries({ queryKey: ['assist-v3-operations', sessionId] });
    }
  }
  return { beginTask, endTask, perform, refresh };
}

export type AssistTasks = ReturnType<typeof useAssistTasks>;
export type AssistActionContext = {
  input: AssistControllerInput;
  state: AssistControllerState;
  data: AssistControllerData;
  client: QueryClient;
  tasks: AssistTasks;
  toast: Toast;
};

export function useAssistControllerEffects(context: AssistActionContext) {
  const { input, state, data, client, tasks, toast } = context;
  useEffect(() => {
    state.pendingSelectionId.current = null;
    state.setSelectedId(undefined);
    state.setView('chat');
    state.setTerminal(null);
    state.setReviewTarget(null);
    state.processedOperations.current.clear();
    state.synchronizedOperations.current.clear();
    state.synchronizedProposalEvents.current.clear();
  }, [input.projectId, input.scopeType, input.scopeId]);
  useEffect(() => {
    state.processedOperations.current.clear();
    state.synchronizedOperations.current.clear();
    state.synchronizedProposalEvents.current.clear();
  }, [state.selectedId]);
  useEffect(() => {
    const rows = (data.sessions.data || []).filter((item) => !item.deleted_at);
    if (state.pendingSelectionId.current && rows.some((item) => item.id === state.pendingSelectionId.current))
      state.pendingSelectionId.current = null;
    if (!rows.length) {
      if (!data.sessions.isLoading && !state.pendingSelectionId.current) state.setSelectedId(undefined);
      return;
    }
    if (!state.selectedId) state.setSelectedId(rows[0].id);
    else if (
      !rows.some((item) => item.id === state.selectedId) &&
      state.pendingSelectionId.current !== state.selectedId
    )
      state.setSelectedId(rows[0].id);
  }, [data.sessions.data, data.sessions.isLoading, state.selectedId]);
  useEffect(() => {
    const rows = data.profiles.data || [],
      active =
        rows.find((item) => item.is_active && !item.assist_configuration) ||
        rows.find((item) => !item.assist_configuration);
    if (
      active &&
      (!state.profileId || !rows.some((item) => item.id === state.profileId && !item.assist_configuration))
    ) {
      state.setProfileId(active.id);
      state.setModelState(active.model || '');
      state.setReasoning(active.reasoning || '');
    }
  }, [data.profiles.data, state.profileId]);
  useEffect(() => {
    const catalog = data.models.data,
      entries = Array.isArray(catalog?.models) ? catalog.models : [];
    if (!entries.length) return;
    const selected =
      entries.find((item) => item.model === state.model) ||
      entries.find((item) => item.model === catalog?.default_model) ||
      entries[0];
    if (!selected) return;
    if (!state.model) state.setModelState(selected.model);
    const efforts = selected.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    if (!efforts.includes(state.reasoning))
      state.setReasoning(selected.defaultReasoningEffort || efforts[0] || state.reasoning);
  }, [data.models.data, state.model, state.reasoning]);
  useEffect(() => {
    state.setAttachmentIds((ids) =>
      ids.filter((item) => data.session?.attachments?.some((attachment) => attachment.id === item))
    );
  }, [data.session?.id, data.session?.attachments?.length]);
  useEffect(() => {
    const prefill = (event: Event) => {
      const value = (event as CustomEvent<{ prompt?: string }>).detail?.prompt?.trim();
      if (value) {
        state.setPrompt(value);
        state.setOperationReferenceId(null);
      }
    };
    window.addEventListener('aiws:assist-prefill', prefill);
    return () => window.removeEventListener('aiws:assist-prefill', prefill);
  }, []);
  useEffect(() => {
    let active = true;
    state.setTerminal(null);
    state.setTerminalRolledBack(false);
    if (!data.session?.id)
      return () => {
        active = false;
      };
    const query = new URLSearchParams({
      project_id: data.session.project_id,
      assist_session_id: data.session.id
    });
    api<TerminalSession[]>(`/assist/v3/terminal-sessions?${query}`)
      .then((items) => {
        if (active && items[0]) state.setTerminal(items[0]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [data.session?.id, data.session?.project_id]);
  useEffect(() => {
    synchronizeCommittedOperations(context);
    synchronizeProposalEvents(context);
    executeClaimableOperations(context);
  }, [data.stream.events, input.route, data.operations.data]);
}

function synchronizeCommittedOperations({ input, state, data, client }: AssistActionContext) {
  if (!Array.isArray(data.operations.data)) return;
  for (const event of data.stream.events.filter(
    (item) =>
      item.type === 'operation' &&
      item.data.execution_layer === 'server' &&
      item.data.status === 'committed' &&
      typeof item.data.operation_id === 'string'
  )) {
    const operationId = String(event.data.operation_id);
    if (state.synchronizedOperations.current.has(operationId)) continue;
    state.synchronizedOperations.current.add(operationId);
    if (input.projectId) {
      void client.invalidateQueries({ queryKey: keys.onboarding(input.projectId) });
      void client.invalidateQueries({ queryKey: keys.project(input.projectId) });
    }
  }
}

function synchronizeProposalEvents({ input, state, data, client }: AssistActionContext) {
  if (!Array.isArray(data.operations.data)) return;
  for (const event of data.stream.events.filter(
    (item) =>
      item.type === 'operation' &&
      item.data.result_kind === 'change_proposal' &&
      typeof item.data.operation_id === 'string'
  )) {
    const key = `${event.data.operation_id}:${event.data.proposal_status || 'pending'}:${event.data.revision || 0}`;
    if (state.synchronizedProposalEvents.current.has(key)) continue;
    state.synchronizedProposalEvents.current.add(key);
    if (state.selectedId) void client.invalidateQueries({ queryKey: ['assist-v3-operations', state.selectedId] });
    void client.invalidateQueries({ queryKey: keys.approvals(input.projectId) });
    void client.invalidateQueries({ queryKey: keys.proposals(input.projectId) });
    if (input.projectId && event.data.proposal_status === 'applied')
      void client.invalidateQueries({ queryKey: keys.project(input.projectId) });
  }
}

function executeClaimableOperations({ input, state, data, tasks, toast }: AssistActionContext) {
  if (!Array.isArray(data.operations.data)) return;
  for (const event of data.stream.events.filter(
    (item) => item.type === 'operation' && item.data.claimable === true && typeof item.data.operation_id === 'string'
  )) {
    const operationId = String(event.data.operation_id);
    if (state.processedOperations.current.has(operationId)) continue;
    if (!data.operations.data.some((item) => item.id === operationId && item.status === 'pending')) continue;
    state.processedOperations.current.add(operationId);
    void executeAssistOperation(operationId, input.route)
      .then(() => tasks.refresh())
      .catch((error) => {
        state.processedOperations.current.delete(operationId);
        toast((error as Error).message, 'error');
      });
  }
}

export function useAssistSessionActions(context: AssistActionContext) {
  const { input, state, data, client, tasks, toast } = context;
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
  async function createScopedSession() {
    if (!input.projectId || !input.scopeType || !input.scopeId) throw new Error('当前页面没有可用的智能助手作用域。');
    const label = { project: '项目', workflow: '工作流', workstream: '成果节点', task: '任务' }[input.scopeType];
    const surface = describeAssistSurface();
    const created = await api<AssistV3Session>(
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
  async function resolveSubmitSession() {
    if (
      data.session &&
      !data.session.archived_at &&
      data.session.project_id === input.projectId &&
      data.session.scope_type === input.scopeType &&
      data.session.scope_id === input.scopeId &&
      data.session.scope_status !== 'invalidated'
    )
      return data.session;
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
  return {
    selectModel,
    selectConfiguration,
    resolveSubmitSession,
    createSession,
    showArchived,
    rename,
    pin,
    archive,
    fork,
    deleteBranch,
    restoreDeleted
  };
}

export type AssistSessionActions = ReturnType<typeof useAssistSessionActions>;

export function useAssistConversationActions(context: AssistActionContext, sessions: AssistSessionActions) {
  const { input, state, data, client, tasks, toast } = context;
  function submit(behavior: FollowUp) {
    const content = state.prompt.trim();
    if (!content || !input.projectId) return;
    useUi.getState().setAssist(true);
    const collaborationMode = state.planNext ? 'plan' : 'default',
      selectedAttachments = [...state.attachmentIds];
    void tasks.perform(async () => {
      const target = await sessions.resolveSubmitSession();
      const active = activeTurn(target.turns || []) || (target.id === data.session?.id ? data.running : null);
      const surface = describeAssistSurface();
      const body = {
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
      };
      const endpoint = active
        ? `/assist/v3/sessions/${target.id}/follow-ups`
        : `/assist/v3/sessions/${target.id}/turns`;
      await api<AssistV3Turn>(
        endpoint,
        json('POST', active ? { ...body, behavior } : body, active ? '发送智能助手后续消息' : '启动智能助手处理')
      );
      state.setPrompt((current) => (current.trim() === content ? '' : current));
      state.setPlanNext(false);
      state.setOperationReferenceId(null);
      await tasks.refresh(target.id);
    });
  }
  function stop() {
    if (!data.running) return;
    void tasks.perform(async () => {
      await api(`/assist/v3/turns/${data.running?.id}/stop`, json('POST', { reason: 'user_stop' }, '停止智能助手处理'));
      await tasks.refresh();
    });
  }
  function retry(turn: AssistV3Turn) {
    void tasks.perform(async () => {
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
    });
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
  return { submit, stop, retry, saveConfiguration, setGoal, clearGoal, setClarificationPolicy, respondUserInput };
}

export function useAssistOperationActions(context: AssistActionContext) {
  const { input, state, data, client, tasks } = context;
  function confirmOperation(item: AssistOperation, approved: boolean) {
    void tasks.perform(async () => {
      await api(
        `/assist/v3/operations/${item.id}/confirm`,
        json('POST', { approved }, approved ? '确认智能助手操作' : '拒绝智能助手操作')
      );
      await tasks.refresh();
    });
  }
  function undoOperation(item: AssistOperation, force = false) {
    void tasks.perform(async () => {
      const surface = describeAssistSurface();
      await api(
        `/assist/v3/operations/${item.inverse_of || item.id}/undo`,
        json(
          'POST',
          {
            force,
            route: input.route,
            surface_id: surface.id,
            surface_revision: surface.revision,
            browser_instance_id: surface.browser_instance_id,
            session_id: data.session?.id
          },
          '撤销智能助手操作'
        )
      );
      if (input.projectId) await client.invalidateQueries({ queryKey: keys.onboarding(input.projectId) });
      await tasks.refresh();
    });
  }
  function reviseOperation(item: AssistOperation) {
    const initial = item.current_value ?? item.after_value ?? '';
    const raw = window.prompt(
      `直接编辑“${item.target_label || item.target_id}”`,
      typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2)
    );
    if (raw == null) return;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* Plain text is a valid field value. */
    }
    void tasks.perform(async () => {
      const surface = describeAssistSurface();
      await api(
        `/assist/v3/operations/${item.id}/revisions`,
        json(
          'POST',
          {
            value,
            route: input.route,
            surface_id: surface.id,
            surface_revision: surface.revision,
            browser_instance_id: surface.browser_instance_id,
            session_id: data.session?.id
          },
          '修订智能助手操作'
        )
      );
      if (input.projectId) await client.invalidateQueries({ queryKey: keys.onboarding(input.projectId) });
      await tasks.refresh();
    });
  }
  function continueOperation(item: AssistOperation) {
    state.setOperationReferenceId(item.id);
    state.setPrompt(`继续修改“${item.target_label || item.target_id}”：`);
  }
  return { confirmOperation, undoOperation, reviseOperation, continueOperation };
}

export function useAssistViewActions(context: AssistActionContext, sessions: AssistSessionActions) {
  const { input, state, data, client, tasks, toast } = context;
  function openReview(turn: AssistV3Turn) {
    state.setReviewTarget({ kind: 'turn', id: turn.id });
    state.setView('review');
  }
  function openTerminal(runtime: TerminalRuntime = 'linux_container') {
    if (!data.session || !input.projectId) return;
    state.setTerminalSelectorOpen(false);
    void tasks.perform(async () => {
      const created = await api<TerminalSession>(
        '/assist/v3/terminal-sessions',
        json(
          'POST',
          {
            project_id: input.projectId,
            assist_session_id: data.session?.id,
            profile_id: state.profileId || undefined,
            configuration_id: state.configurationId || undefined,
            model: state.model,
            reasoning: state.reasoning,
            runtime,
            cols: 120,
            rows: 32
          },
          '启动智能助手终端'
        )
      );
      state.setTerminal(created);
      state.setTerminalRolledBack(false);
      state.setView('terminal');
    });
  }
  function openTerminalReview() {
    if (state.terminal && !state.terminalRolledBack) {
      state.setReviewTarget({ kind: 'terminal', id: state.terminal.id });
      state.setView('review');
    }
  }
  function backToChat() {
    state.setView('chat');
    state.setReviewTarget(null);
  }
  function resolveReview(action: 'apply' | 'rollback') {
    if (state.reviewTarget?.kind === 'terminal' && action === 'rollback') state.setTerminalRolledBack(true);
    backToChat();
    void tasks.refresh();
  }
  function showTerminal() {
    if (state.terminal) state.setView('terminal');
    else state.setTerminalSelectorOpen(true);
  }
  function showReview() {
    if (state.reviewTarget) state.setView('review');
  }
  function addAttachment(item: AssistAttachment) {
    client.setQueryData<AssistV3Session>(assistKeys.session(data.session?.id), (current) =>
      current ? { ...current, attachments: [...(current.attachments || []), item] } : current
    );
  }
  function attachmentDeleted(item: AssistAttachment, tombstone: boolean) {
    state.setAttachmentIds((ids) => ids.filter((key) => key !== item.id));
    client.setQueryData<AssistV3Session>(assistKeys.session(data.session?.id), (current) =>
      current
        ? {
            ...current,
            attachments: tombstone
              ? (current.attachments || []).map((entry) => (entry.id === item.id ? item : entry))
              : (current.attachments || []).filter((entry) => entry.id !== item.id)
          }
        : current
    );
  }
  function composerCommand(command: AssistCommand) {
    if (command === 'goal') window.dispatchEvent(new Event('aiws:edit-goal'));
    else if (command === 'review') {
      const target = [...data.turns]
        .reverse()
        .find((turn) => turn.change_batch_id && ['ready', 'changes_requested', 'applied'].includes(turn.review_status));
      if (target) openReview(target);
      else toast('当前线程没有可审查的变更');
    } else if (command === 'fork' && data.session) sessions.fork(data.session);
    else if (command === 'btw') publishSelectionAsk({ selection: '', rect: null, pageUrl: window.location.href });
  }
  return {
    openReview,
    openTerminal,
    openTerminalReview,
    resolveReview,
    showTerminal,
    showReview,
    addAttachment,
    attachmentDeleted,
    composerCommand,
    backToChat
  };
}
