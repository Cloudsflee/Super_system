import { api, json } from '../../api/client';
import type { AssistAttachment, AssistV3Session, AssistV3Turn, TerminalSession } from '../../api/types';
import { publishSelectionAsk } from '../../components/common/selection-ask';
import { assistKeys } from './assist-api';
import type { AssistCommand } from './composer-support';
import type { AssistActionContext, AssistSessionActions, TerminalRuntime } from './assist-controller-support';

export function useAssistViewActions(context: AssistActionContext, sessions: AssistSessionActions) {
  const review = createReviewActions(context),
    terminal = createTerminalActions(context, review.backToChat),
    attachments = createAttachmentActions(context),
    composerCommand = createComposerCommand(context, sessions, review.openReview);
  return { ...review, ...terminal, ...attachments, composerCommand };
}

function createReviewActions(context: AssistActionContext) {
  const { state, tasks } = context;
  function openReview(turn: AssistV3Turn) {
    state.setReviewTarget({ kind: 'turn', id: turn.id });
    state.setView('review');
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
  function showReview() {
    if (state.reviewTarget) state.setView('review');
  }
  return { openReview, backToChat, resolveReview, showReview };
}

function createTerminalActions(context: AssistActionContext, backToChat: () => void) {
  const { input, state, data, tasks } = context;
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
  function showTerminal() {
    if (state.terminal) state.setView('terminal');
    else state.setTerminalSelectorOpen(true);
  }
  return { openTerminal, openTerminalReview, showTerminal, backToChat };
}

function createAttachmentActions({ state, data, client }: AssistActionContext) {
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
  return { addAttachment, attachmentDeleted };
}

function createComposerCommand(
  { data, toast }: AssistActionContext,
  sessions: AssistSessionActions,
  openReview: (turn: AssistV3Turn) => void
) {
  return (command: AssistCommand) => {
    if (command === 'goal') window.dispatchEvent(new Event('aiws:edit-goal'));
    else if (command === 'review') {
      const target = [...data.turns]
        .reverse()
        .find((turn) => turn.change_batch_id && ['ready', 'changes_requested', 'applied'].includes(turn.review_status));
      if (target) openReview(target);
      else toast('当前线程没有可审查的变更');
    } else if (command === 'fork' && data.session) sessions.fork(data.session);
    else if (command === 'btw') publishSelectionAsk({ selection: '', rect: null, pageUrl: window.location.href });
  };
}
