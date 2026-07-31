import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type {
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
import type { ReviewTarget } from './DiffReviewPanel';

export { useAssistViewActions } from './assist-controller-view-actions';
export { useAssistConversationActions } from './assist-controller-conversation-actions';
export { useAssistSessionActions } from './assist-controller-session-actions';
export type { AssistSessionActions } from './assist-controller-session-actions';

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
