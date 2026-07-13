import { Ban, Check, CornerDownLeft, ListTodo, Paperclip, Save, Send, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AssistAttachment, AssistConfiguration, AssistModelCatalog, AssistV3Session, AssistV3Turn } from '../../api/types';
import { AttachmentTray } from './AttachmentTray';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type Props = {
  session: AssistV3Session; profileName: string; catalog?: AssistModelCatalog; configurations: AssistConfiguration[];
  model: string; reasoning: string; configurationId: string; planNext: boolean; prompt: string;
  attachments: AssistAttachment[]; selectedAttachments: string[]; activeTurn: AssistV3Turn | null; busy: boolean; writeModeUnavailableReason: string | null;
  onModel: (value: string) => void; onReasoning: (value: string) => void; onConfiguration: (value: string) => void; onPlanNext: (value: boolean) => void; onPrompt: (value: string) => void;
  onAttachments: (ids: string[]) => void; onAttachmentCreated: (item: AssistAttachment) => void; onSubmit: (behavior: FollowUp) => void; onStop: () => void; onTerminal: () => void;
  onSaveConfiguration: (name: string) => Promise<boolean>; onError: (message: string) => void;
};

export function AssistComposer(props: Props) {
  const [behavior, setBehavior] = useState<FollowUp>(() => (sessionStorage.getItem('aiws-follow-up-behavior') || 'queue') as FollowUp);
  const [menu, setMenu] = useState<'model' | 'reasoning' | null>(null), [saveOpen, setSaveOpen] = useState(false), [configurationName, setConfigurationName] = useState('');
  const menuRoot = useRef<HTMLDivElement>(null), running = Boolean(props.activeTurn), modelEntry = props.catalog?.models?.find((item) => item.model === props.model);
  const efforts = modelEntry?.supportedReasoningEfforts || [];
  const valid = Boolean(props.model && props.reasoning && props.prompt.trim());
  useEffect(() => { if (!menu) return; const close = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) { setMenu(null); setSaveOpen(false); } }; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); setSaveOpen(false); } }; document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape); return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); }; }, [menu]);
  function chooseBehavior(value: FollowUp) { setBehavior(value); sessionStorage.setItem('aiws-follow-up-behavior', value); }
  function submit() { if (valid) props.onSubmit(behavior); }
  function openSave() { setConfigurationName(`${props.profileName} · ${props.model} · ${props.reasoning}`.slice(0, 100)); setSaveOpen(true); }
  async function save() { if (configurationName.trim() && await props.onSaveConfiguration(configurationName.trim())) { setSaveOpen(false); setMenu(null); } }
  return <section className="assist-composer-v3">
    {props.writeModeUnavailableReason && <div className="assist-mode-unavailable" role="status">代码工作区只读：{props.writeModeUnavailableReason}；网页低风险语义操作仍可使用。</div>}
    <textarea aria-label="Assist 消息" rows={3} value={props.prompt} onChange={(event) => props.onPrompt(event.target.value)} placeholder={props.planNext ? '描述要由 Codex 原生 Plan 拆解的目标' : running ? '添加 follow-up' : '让 Codex 完成任务或回答问题'} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(); }} />
    <AttachmentTray sessionId={props.session.id} attachments={props.attachments} selectedIds={props.selectedAttachments} onSelected={props.onAttachments} onCreated={props.onAttachmentCreated} onError={props.onError} />
    <footer className="codex-composer-controls">
      <div className="composer-native-controls" ref={menuRoot}>
        <button type="button" className="composer-text-control" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{props.model || '选择模型'}</button>
        <button type="button" className="composer-text-control" aria-expanded={menu === 'reasoning'} onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')}>{props.reasoning || 'reasoning'}</button>
        <button type="button" className={`composer-plan-toggle${props.planNext ? ' active' : ''}`} aria-pressed={props.planNext} onClick={() => props.onPlanNext(!props.planNext)}><ListTodo size={13} />Plan</button>
        <button type="button" className="composer-icon-control" aria-label="附件" onClick={() => document.querySelector<HTMLButtonElement>('.attachment-add-button')?.click()}><Paperclip size={14} /></button>
        <button type="button" className="composer-icon-control" aria-label="打开 Terminal 运行时选择器" onClick={props.onTerminal}><TerminalSquare size={14} /></button>
        {menu === 'model' && <div className="composer-native-menu model-menu" role="menu" aria-label="Codex 模型">
          <header><strong>Model</strong><small>{props.catalog?.source || props.profileName}</small></header>
          {(props.catalog?.models || []).map((item) => <button role="menuitemradio" aria-checked={item.model === props.model} key={item.id} onClick={() => { props.onModel(item.model); setMenu(null); }}><span><strong>{item.displayName}</strong><small>{item.description}</small></span>{item.model === props.model && <Check size={13} />}</button>)}
          {!!props.configurations.length && <><hr /><span className="menu-label">已保存配置</span>{props.configurations.map((item) => <button role="menuitemradio" aria-checked={item.id === props.configurationId} key={item.id} onClick={() => { props.onConfiguration(item.id); setMenu(null); }}><span><strong>{item.name}</strong><small>{item.model} · {item.reasoning}</small></span>{item.id === props.configurationId && <Check size={13} />}</button>)}</>}
          <button className="menu-save" onClick={openSave}><Save size={13} />保存当前配置</button>
          {saveOpen && <div className="save-configuration"><input autoFocus aria-label="配置名称" value={configurationName} onChange={(event) => setConfigurationName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} /><button aria-label="取消保存配置" onClick={() => setSaveOpen(false)}><X size={13} /></button><button aria-label="确认保存配置" onClick={() => void save()}><Check size={13} /></button></div>}
        </div>}
        {menu === 'reasoning' && <div className="composer-native-menu reasoning-menu" role="menu" aria-label="Codex reasoning">
          <header><strong>Reasoning</strong><small>{props.model}</small></header>
          {efforts.map((item) => <button role="menuitemradio" aria-checked={item.reasoningEffort === props.reasoning} key={item.reasoningEffort} onClick={() => { props.onReasoning(item.reasoningEffort); setMenu(null); }}><span><strong>{item.reasoningEffort}</strong><small>{item.description}</small></span>{item.reasoningEffort === props.reasoning && <Check size={13} />}</button>)}
        </div>}
      </div>
      {running && <select aria-label="Follow-up 行为" value={behavior} onChange={(event) => chooseBehavior(event.target.value as FollowUp)}><option value="queue">排队</option><option value="steer">Steer</option><option value="interrupt">Interrupt</option></select>}
      <span className="composer-shortcut"><CornerDownLeft size={12} />Ctrl/⌘ Enter</span>
      {running && <button className="button danger" disabled={props.busy} onClick={props.onStop}><Ban size={14} />Stop</button>}
      <button className="button primary" aria-label="发送" disabled={props.busy || !valid} onClick={submit}><Send size={14} />{running ? followUpLabel(behavior) : '发送'}</button>
    </footer>
  </section>;
}

function followUpLabel(value: FollowUp) { return value === 'interrupt' ? '中断并接管' : value === 'steer' ? 'Steer' : '加入队列'; }
