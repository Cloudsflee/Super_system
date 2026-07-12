import { Ban, Bot, Check, Code2, CornerDownLeft, ListTodo, Save, Send, TerminalSquare, X } from 'lucide-react';
import { useState } from 'react';
import type { AssistAttachment, AssistComposerMode, AssistV3Session, AssistV3Turn, CodexProfile } from '../../api/types';
import { AttachmentTray } from './AttachmentTray';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type Props = {
  session: AssistV3Session; profiles: CodexProfile[]; mode: AssistComposerMode; profileId: string;
  model: string; reasoning: string; prompt: string; attachments: AssistAttachment[]; selectedAttachments: string[]; activeTurn: AssistV3Turn | null; busy: boolean;
  writeModeUnavailableReason: string | null;
  onMode: (value: AssistComposerMode) => void; onProfile: (id: string) => void; onModel: (value: string) => void; onReasoning: (value: string) => void; onPrompt: (value: string) => void;
  onAttachments: (ids: string[]) => void; onAttachmentCreated: (item: AssistAttachment) => void;
  onSubmit: (behavior: FollowUp) => void; onStop: () => void; onSaveConfiguration: (name: string) => Promise<boolean>; onError: (message: string) => void;
};

const modes: Array<{ id: AssistComposerMode; label: string; icon: typeof Bot; detail: string }> = [
  { id: 'ask', label: 'Ask', icon: Bot, detail: '只读回答' },
  { id: 'plan', label: 'Plan', icon: ListTodo, detail: '只读规划' },
  { id: 'agent', label: 'Agent', icon: Code2, detail: '独立 worktree' },
  { id: 'cli', label: 'CLI', icon: TerminalSquare, detail: '真实 Codex TUI' }
];

export function AssistComposer(props: Props) {
  const [behavior, setBehavior] = useState<FollowUp>(() => (sessionStorage.getItem('aiws-follow-up-behavior') || 'queue') as FollowUp);
  const [saveOpen, setSaveOpen] = useState(false);
  const [configurationName, setConfigurationName] = useState('');
  const profile = props.profiles.find((item) => item.id === props.profileId) || props.profiles.find((item) => item.is_active) || props.profiles[0];
  const running = Boolean(props.activeTurn);
  const selectedModeUnavailable = Boolean(props.writeModeUnavailableReason && ['agent', 'cli'].includes(props.mode));
  const validModel = /^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/.test(props.model);
  function chooseBehavior(value: FollowUp) { setBehavior(value); sessionStorage.setItem('aiws-follow-up-behavior', value); }
  function submit() { if (validModel && !selectedModeUnavailable && (props.mode === 'cli' || props.prompt.trim())) props.onSubmit(behavior); }
  function openSave() { setConfigurationName(`${profile?.name || 'Assist'} · ${props.model} · ${props.reasoning}`.slice(0, 100)); setSaveOpen(true); }
  async function save() { if (configurationName.trim() && validModel && await props.onSaveConfiguration(configurationName.trim())) setSaveOpen(false); }
  const models = [...new Set(props.profiles.map((item) => item.model).filter(Boolean))] as string[];
  return <section className="assist-composer-v3">
    <div className="composer-mode-row">
      <div className="assist-mode-picker" role="group" aria-label="Assist 模式">{modes.map(({ id, label, icon: Icon, detail }) => { const disabled = Boolean(props.writeModeUnavailableReason && ['agent', 'cli'].includes(id)); return <button title={disabled ? props.writeModeUnavailableReason || detail : detail} disabled={disabled} className={props.mode === id ? 'active' : ''} key={id} onClick={() => props.onMode(id)}><Icon size={13} />{label}</button>; })}</div>
      <div className="profile-picker"><select aria-label="Codex Profile" value={profile?.id || ''} onChange={(event) => props.onProfile(event.target.value)}>{!props.profiles.length && <option value="">无可用 Profile</option>}{props.profiles.map((item) => <option value={item.id} key={item.id}>{item.assist_configuration ? '已存 · ' : ''}{item.name}</option>)}</select><button className="icon-button" aria-label="保存当前 Assist 配置" title="保存当前 Assist 配置" disabled={!profile || !validModel || props.busy} onClick={openSave}><Save size={14} /></button></div>
    </div>
    <div className="assist-turn-config">
      <label><span>模型</span><input aria-label="当前模型" list="assist-model-options" value={props.model} onChange={(event) => props.onModel(event.target.value.trim())} spellCheck={false} aria-invalid={!validModel} /></label>
      <datalist id="assist-model-options">{models.map((model) => <option value={model} key={model} />)}</datalist>
      <fieldset><legend>思考深度</legend><div className="reasoning-picker">{['low', 'medium', 'high', 'xhigh'].map((value) => <button type="button" className={props.reasoning === value ? 'active' : ''} aria-pressed={props.reasoning === value} onClick={() => props.onReasoning(value)} key={value}>{value}</button>)}</div></fieldset>
    </div>
    <div className="profile-summary"><span>{profile?.provider_name || profile?.provider || 'Codex'}</span><i>{profile?.kind || 'host'}</i>{profile?.assist_configuration && <i>saved</i>}</div>
    {saveOpen && <div className="save-configuration"><input autoFocus aria-label="配置名称" value={configurationName} maxLength={100} onChange={(event) => setConfigurationName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setSaveOpen(false); }} /><button className="icon-button" aria-label="取消保存配置" title="取消" onClick={() => setSaveOpen(false)}><X size={14} /></button><button className="icon-button primary" aria-label="确认保存配置" title="保存" disabled={!configurationName.trim() || props.busy} onClick={() => void save()}><Check size={14} /></button></div>}
    {props.writeModeUnavailableReason && <div className="assist-mode-unavailable" role="status">Agent 和 CLI 暂不可用：{props.writeModeUnavailableReason}</div>}
    {props.mode !== 'cli' ? <textarea aria-label="Assist 消息" rows={3} value={props.prompt} onChange={(event) => props.onPrompt(event.target.value)} placeholder={running ? '添加 follow-up，选择排队、steer 或 interrupt' : props.mode === 'agent' ? '描述要在独立 worktree 中完成的编码任务' : props.mode === 'plan' ? '描述需要拆解和规划的目标' : '询问当前项目'} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(); }} /> : <div className="cli-composer-hint"><TerminalSquare size={17} /><span>启动真实 Codex TUI；退出后进入同一套 Diff Review。</span></div>}
    <AttachmentTray sessionId={props.session.id} attachments={props.attachments} selectedIds={props.selectedAttachments} onSelected={props.onAttachments} onCreated={props.onAttachmentCreated} onError={props.onError} />
    <footer>
      {running && props.mode !== 'cli' && <select aria-label="Follow-up 行为" value={behavior} onChange={(event) => chooseBehavior(event.target.value as FollowUp)}><option value="queue">排队</option><option value="steer">Steer</option><option value="interrupt">Interrupt</option></select>}
      <span><CornerDownLeft size={12} />Ctrl/⌘ + Enter</span>
      {running && <button className="button danger" disabled={props.busy} onClick={props.onStop}><Ban size={14} />Stop</button>}
      <button className="button primary" disabled={props.busy || !profile || !validModel || selectedModeUnavailable || (props.mode !== 'cli' && !props.prompt.trim())} onClick={submit}>{props.mode === 'cli' ? <TerminalSquare size={14} /> : <Send size={14} />}{props.mode === 'cli' ? '启动 CLI' : running ? followUpLabel(behavior) : '发送'}</button>
    </footer>
  </section>;
}

function followUpLabel(value: FollowUp) { return value === 'interrupt' ? '中断并接管' : value === 'steer' ? 'Steer' : '加入队列'; }
