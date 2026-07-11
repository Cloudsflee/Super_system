import { Ban, Bot, Code2, CornerDownLeft, ListTodo, Send, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import type { AssistAttachment, AssistComposerMode, AssistV3Session, AssistV3Turn, CodexProfile } from '../../api/types';
import { AttachmentTray } from './AttachmentTray';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type Props = {
  session: AssistV3Session; profiles: CodexProfile[]; mode: AssistComposerMode; profileId: string;
  prompt: string; attachments: AssistAttachment[]; selectedAttachments: string[]; activeTurn: AssistV3Turn | null; busy: boolean;
  onMode: (value: AssistComposerMode) => void; onProfile: (id: string) => void; onPrompt: (value: string) => void;
  onAttachments: (ids: string[]) => void; onAttachmentCreated: (item: AssistAttachment) => void;
  onSubmit: (behavior: FollowUp) => void; onStop: () => void; onError: (message: string) => void;
};

const modes: Array<{ id: AssistComposerMode; label: string; icon: typeof Bot; detail: string }> = [
  { id: 'ask', label: 'Ask', icon: Bot, detail: '只读回答' },
  { id: 'plan', label: 'Plan', icon: ListTodo, detail: '只读规划' },
  { id: 'agent', label: 'Agent', icon: Code2, detail: '独立 worktree' },
  { id: 'cli', label: 'CLI', icon: TerminalSquare, detail: '真实 Codex TUI' }
];

export function AssistComposer(props: Props) {
  const [behavior, setBehavior] = useState<FollowUp>(() => (sessionStorage.getItem('aiws-follow-up-behavior') || 'queue') as FollowUp);
  const profile = props.profiles.find((item) => item.id === props.profileId) || props.profiles.find((item) => item.is_active) || props.profiles[0];
  const running = Boolean(props.activeTurn);
  function chooseBehavior(value: FollowUp) { setBehavior(value); sessionStorage.setItem('aiws-follow-up-behavior', value); }
  function submit() { if (props.mode === 'cli' || props.prompt.trim()) props.onSubmit(behavior); }
  return <section className="assist-composer-v3">
    <div className="composer-mode-row">
      <div className="assist-mode-picker" role="group" aria-label="Assist 模式">{modes.map(({ id, label, icon: Icon, detail }) => <button title={detail} className={props.mode === id ? 'active' : ''} key={id} onClick={() => props.onMode(id)}><Icon size={13} />{label}</button>)}</div>
      <select aria-label="Codex Profile" value={profile?.id || ''} onChange={(event) => props.onProfile(event.target.value)}>{!props.profiles.length && <option value="">无可用 Profile</option>}{props.profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
    </div>
    <div className="profile-summary"><span>{profile?.model || 'default model'}</span><i>{profile?.reasoning || 'default'} reasoning</i><i>{profile?.kind || 'host'}</i></div>
    {props.mode !== 'cli' ? <textarea aria-label="Assist 消息" rows={3} value={props.prompt} onChange={(event) => props.onPrompt(event.target.value)} placeholder={running ? '添加 follow-up，选择排队、steer 或 interrupt' : props.mode === 'agent' ? '描述要在独立 worktree 中完成的编码任务' : props.mode === 'plan' ? '描述需要拆解和规划的目标' : '询问当前项目'} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(); }} /> : <div className="cli-composer-hint"><TerminalSquare size={17} /><span>启动真实 Codex TUI；退出后进入同一套 Diff Review。</span></div>}
    <AttachmentTray sessionId={props.session.id} attachments={props.attachments} selectedIds={props.selectedAttachments} onSelected={props.onAttachments} onCreated={props.onAttachmentCreated} onError={props.onError} />
    <footer>
      {running && props.mode !== 'cli' && <select aria-label="Follow-up 行为" value={behavior} onChange={(event) => chooseBehavior(event.target.value as FollowUp)}><option value="queue">排队</option><option value="steer">Steer</option><option value="interrupt">Interrupt</option></select>}
      <span><CornerDownLeft size={12} />Ctrl/⌘ + Enter</span>
      {running && <button className="button danger" disabled={props.busy} onClick={props.onStop}><Ban size={14} />Stop</button>}
      <button className="button primary" disabled={props.busy || !profile || (props.mode !== 'cli' && !props.prompt.trim())} onClick={submit}>{props.mode === 'cli' ? <TerminalSquare size={14} /> : <Send size={14} />}{props.mode === 'cli' ? '启动 CLI' : running ? followUpLabel(behavior) : '发送'}</button>
    </footer>
  </section>;
}

function followUpLabel(value: FollowUp) { return value === 'interrupt' ? '中断并接管' : value === 'steer' ? 'Steer' : '加入队列'; }
