import { Ban, Bot, Plus, RotateCcw, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, json, streamUrl } from '../../api/client';
import type { AssistEvent, AssistMessage, AssistSession, UiAction } from '../../api/types';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { ActionIntent } from './ActionIntent';
import { describeAssistSurface, dispatchSemanticAction } from './semantic-actions';

export function AssistDrawer({ projectId, nodeId }: { projectId?: string; nodeId?: string }) {
  const { assistOpen, setAssist, toast } = useUi();
  const [session, setSession] = useState<AssistSession | null>(null);
  const [messages, setMessages] = useState<AssistMessage[]>([]);
  const [actions, setActions] = useState<UiAction[]>([]);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const lastEvent = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();
  const scopeId = nodeId || projectId;

  useEffect(() => {
    let active = true;
    setSession(null);
    setMessages([]);
    setActions([]);
    setRunning(false);
    lastEvent.current = 0;
    if (!scopeId || !projectId)
      return () => {
        active = false;
      };
    const scopeType = nodeId ? 'node' : 'project';
    const query = new URLSearchParams({ project_id: projectId, scope_type: scopeType, scope_id: scopeId, limit: '1' });
    api<AssistSession[]>(`/assist/v2/sessions?${query}`)
      .then(async (items) => (items[0] ? api<AssistSession>(`/assist/v2/sessions/${items[0].id}`) : null))
      .then((value) => {
        if (!active || !value) return;
        setSession(value);
        setMessages(value.messages || []);
        setActions(value.actions || []);
        lastEvent.current = value.last_event_id || 0;
        setRunning(value.status === 'running');
        for (const action of value.actions || [])
          if (action.risk === 'reversible' && action.status === 'ready') void executeAction(action, value.id);
      })
      .catch((error) => {
        if (active) toast(error.message, 'error');
      });
    return () => {
      active = false;
    };
  }, [scopeId, projectId, nodeId, toast]);
  useEffect(() => {
    if (!assistOpen || !session || !running) return;
    const source = new EventSource(streamUrl(session.id, lastEvent.current));
    source.onmessage = (event) => consume(JSON.parse(event.data) as AssistEvent);
    source.addEventListener('assist', (event) => consume(JSON.parse((event as MessageEvent).data) as AssistEvent));
    source.onerror = () => {
      toast('智能助手事件流正在重连', 'error');
    };
    function consume(event: AssistEvent) {
      lastEvent.current = Math.max(lastEvent.current, event.id);
      if (event.type === 'message') setMessages((items) => upsert(items, event.data.message as AssistMessage));
      if (event.type === 'action') {
        const action = event.data.action as UiAction;
        setActions((items) => upsert(items, action));
        if (action.risk === 'reversible' && action.status === 'ready') executeAction(action);
      }
      if (['completed', 'cancelled', 'failed'].includes(event.type)) {
        setRunning(false);
        source.close();
      }
    }
    return () => source.close();
  }, [assistOpen, session, running]);

  async function submit() {
    if (!prompt.trim() || !scopeId) return;
    try {
      const viewContext = {
        route: location.pathname,
        scope_type: nodeId ? 'node' : 'project',
        scope_id: scopeId,
        actions: ['navigate', 'select_node', 'switch_workspace_tab', 'focus_field', 'set_filter', 'fill_field'],
        surface: describeAssistSurface()
      };
      const current =
        session ||
        (await api<AssistSession>(
          '/assist/v2/sessions',
          json(
            'POST',
            {
              project_id: projectId,
              scope_type: nodeId ? 'node' : 'project',
              scope_id: scopeId,
              view_context: viewContext
            },
            '创建智能助手会话'
          )
        ));
      setSession(current);
      const result = await api<{ message: AssistMessage }>(
        `/assist/v2/sessions/${current.id}/messages`,
        json('POST', { content: prompt, view_context: viewContext }, '发送智能助手消息')
      );
      setMessages((items) => upsert(items, result.message));
      setPrompt('');
      setRunning(true);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function cancel() {
    if (!session) return;
    try {
      await api(`/assist/v2/sessions/${session.id}/cancel`, json('POST', undefined, '停止智能助手会话'));
      setRunning(false);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function executeAction(action: UiAction, targetSessionId = session?.id) {
    let ok = true,
      result: Record<string, unknown> = {};
    try {
      if (action.name === 'navigate') {
        navigate(String(action.args.path));
        result = { handled: true, path: action.args.path };
      } else if (action.name === 'select_node') {
        const selected = String(action.args.node_id || '');
        if (!selected || !projectId) throw new Error('node_id_required');
        const target = await api<{ project: { id: string } }>(`/nodes/${selected}/workspace`);
        if (target.project.id !== projectId) throw new Error('node_outside_current_project');
        useUi.getState().inspect(selected);
        if (!location.pathname.includes('/workflow')) navigate(`/projects/${projectId}/workflow`);
        result = { handled: true, node_id: selected };
      } else {
        result = await dispatchSemanticAction(action);
        ok = result.handled === true;
      }
    } catch (error) {
      ok = false;
      result = { error: (error as Error).message };
    }
    try {
      const next = await api<UiAction>(
        `/assist/v2/sessions/${targetSessionId}/actions/${action.id}/result`,
        json('POST', { ok, result }, { name: '同步智能助手操作结果', feedback: 'background', timeoutMs: 120_000 })
      );
      setActions((items) => upsert(items, next));
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <AssistDrawerView
      assistOpen={assistOpen}
      session={session}
      messages={messages}
      actions={actions}
      prompt={prompt}
      running={running}
      nodeId={nodeId}
      scopeId={scopeId}
      onClose={() => setAssist(false)}
      onNewSession={() => {
        setSession(null);
        setMessages([]);
        setActions([]);
        setRunning(false);
        lastEvent.current = 0;
      }}
      onPromptChange={setPrompt}
      onSubmit={submit}
      onCancel={cancel}
      onActionChange={(next) => setActions((items) => upsert(items, next))}
    />
  );
}

function AssistDrawerView({
  assistOpen,
  session,
  messages,
  actions,
  prompt,
  running,
  nodeId,
  scopeId,
  onClose,
  onNewSession,
  onPromptChange,
  onSubmit,
  onCancel,
  onActionChange
}: {
  assistOpen: boolean;
  session: AssistSession | null;
  messages: AssistMessage[];
  actions: UiAction[];
  prompt: string;
  running: boolean;
  nodeId?: string;
  scopeId?: string;
  onClose: () => void;
  onNewSession: () => void;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onActionChange: (action: UiAction) => void;
}) {
  return (
    <aside
      className={`assist-drawer drawer right ${assistOpen ? 'open' : ''}`}
      aria-hidden={!assistOpen}
      inert={!assistOpen}
    >
      <div className="drawer-head">
        <div>
          <span className="overline">Codex 会话</span>
          <h2>
            <Bot size={19} />
            智能助手
          </h2>
        </div>
        <div>
          {session && (
            <IconButton label="新建对话" onClick={onNewSession}>
              <Plus size={18} />
            </IconButton>
          )}
          <IconButton label="关闭智能助手" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
      </div>
      <div className="scope-bar">
        <span>{nodeId ? '节点' : '项目'}</span>
        <strong>{scopeId ? scopeId.slice(0, 16) : '未选择作用域'}</strong>
      </div>
      <div className="conversation">
        {!messages.length && (
          <div className="quiet-empty">
            <Bot size={24} />
            <p>在当前作用域中启动 Codex 会话</p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <span>{message.role === 'user' ? '你' : 'Codex'}</span>
            <p>{message.content}</p>
          </article>
        ))}
        {actions.map((action) => (
          <ActionIntent key={action.id} action={action} sessionId={session?.id || ''} onChange={onActionChange} />
        ))}
        {running && (
          <div className="streaming">
            <i />
            <span>Codex 正在处理</span>
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="向当前工作空间提问"
          rows={3}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onSubmit();
          }}
        />
        <div>
          {running ? (
            <button className="button danger" onClick={onCancel}>
              <Ban size={16} />
              停止
            </button>
          ) : (
            <button className="button primary" disabled={!prompt.trim() || !scopeId} onClick={onSubmit}>
              {session ? <RotateCcw size={16} /> : <Send size={16} />}
              {session ? '继续' : '发送'}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function upsert<T extends { id: string }>(items: T[], next: T) {
  return [...items.filter((item) => item.id !== next.id), next];
}
