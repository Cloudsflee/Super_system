import { useQueryClient } from '@tanstack/react-query';
import type { AssistScopeBreadcrumbItem, AssistScopeType } from '../../api/types';
import { useUi } from '../../state/ui';
import {
  useAssistControllerData,
  useAssistControllerEffects,
  useAssistControllerState,
  useAssistConversationActions,
  useAssistOperationActions,
  useAssistSessionActions,
  useAssistTasks,
  useAssistViewActions,
  type AssistActionContext,
  type AssistControllerInput
} from './assist-controller-support';

export function useAssistController({
  projectId,
  scopeType,
  scopeId,
  scopeBreadcrumb = [],
  enabled,
  route
}: {
  projectId?: string;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  enabled: boolean;
  route: string;
}) {
  const input: AssistControllerInput = { projectId, scopeType, scopeId, scopeBreadcrumb, enabled, route };
  const state = useAssistControllerState();
  const data = useAssistControllerData(input, state);
  const client = useQueryClient();
  const toast = useUi((current) => current.toast);
  const tasks = useAssistTasks(client, toast, state);
  const context: AssistActionContext = { input, state, data, client, tasks, toast };
  useAssistControllerEffects(context);
  const sessions = useAssistSessionActions(context);
  const conversation = useAssistConversationActions(context, sessions);
  const operations = useAssistOperationActions(context);
  const view = useAssistViewActions(context, sessions);

  return {
    projectId,
    scopeType,
    scopeId,
    scopeBreadcrumb,
    search: state.search,
    setSearch: state.setSearch,
    archived: state.archived,
    setArchived: sessions.showArchived,
    selectedId: state.selectedId,
    setSelectedId: state.setSelectedId,
    planNext: state.planNext,
    setPlanNext: state.setPlanNext,
    profileId: state.profileId,
    model: state.model,
    setModel: sessions.selectModel,
    reasoning: state.reasoning,
    setReasoning: state.setReasoning,
    configurationId: state.configurationId,
    selectConfiguration: sessions.selectConfiguration,
    configurations: data.configurations,
    models: data.models,
    prompt: state.prompt,
    setPrompt: state.setPrompt,
    operationReferenceId: state.operationReferenceId,
    attachmentIds: state.attachmentIds,
    setAttachmentIds: state.setAttachmentIds,
    busy: state.busy,
    view: state.view,
    session: data.session,
    sessions: data.sessions,
    profiles: data.profiles,
    stream: data.stream,
    running: data.running,
    goal: data.goal,
    operations: data.operations,
    terminalCapabilities: data.terminalCapabilities,
    terminalSelectorOpen: state.terminalSelectorOpen,
    setTerminalSelectorOpen: state.setTerminalSelectorOpen,
    reviewTarget: state.reviewTarget,
    terminal: state.terminal,
    terminalRolledBack: state.terminalRolledBack,
    setTerminal: state.setTerminal,
    createSession: sessions.createSession,
    rename: sessions.rename,
    pin: sessions.pin,
    archive: sessions.archive,
    fork: sessions.fork,
    deleteBranch: sessions.deleteBranch,
    restoreDeleted: sessions.restoreDeleted,
    submit: conversation.submit,
    stop: conversation.stop,
    retry: conversation.retry,
    openReview: view.openReview,
    openTerminal: view.openTerminal,
    openTerminalReview: view.openTerminalReview,
    resolveReview: view.resolveReview,
    showTerminal: view.showTerminal,
    showReview: view.showReview,
    addAttachment: view.addAttachment,
    attachmentDeleted: view.attachmentDeleted,
    composerCommand: view.composerCommand,
    backToChat: view.backToChat,
    toast,
    refresh: tasks.refresh,
    saveConfiguration: conversation.saveConfiguration,
    setGoal: conversation.setGoal,
    clearGoal: conversation.clearGoal,
    setClarificationPolicy: conversation.setClarificationPolicy,
    respondUserInput: conversation.respondUserInput,
    confirmOperation: operations.confirmOperation,
    undoOperation: operations.undoOperation,
    reviseOperation: operations.reviseOperation,
    continueOperation: operations.continueOperation
  };
}

export type AssistController = ReturnType<typeof useAssistController>;
