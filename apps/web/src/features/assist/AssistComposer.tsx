import {
  Ban,
  Check,
  ClipboardPaste,
  FileUp,
  GripHorizontal,
  Link as LinkIcon,
  ListTodo,
  LockKeyhole,
  Paperclip,
  Save,
  Send,
  TerminalSquare,
  X
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react';
import { api, json } from '../../api/client';
import type {
  AssistAttachment,
  AssistClarificationPolicy,
  AssistConfiguration,
  AssistModelCatalog,
  AssistV3Session,
  AssistV3Turn
} from '../../api/types';
import { useIdeContext, type EditorSelection } from '../../state/ide-context';
import { IconButton } from '../../components/common/IconButton';
import {
  modelDescriptionLabel,
  reasoningEffortDescription,
  reasoningEffortLabel,
  referenceKindLabel
} from '../../components/common/display-labels';
import { AttachmentTray } from './AttachmentTray';
import {
  activeComposerToken,
  ASSIST_COMMANDS,
  removeComposerToken,
  type ActiveToken,
  type AssistCommand,
  type ReferenceCandidate
} from './composer-support';
import { LONG_PASTE_THRESHOLD, useComposerFiles } from './useComposerFiles';
import { useComposerHeight } from './useComposerHeight';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type ComposerMenu = 'model' | 'reasoning' | 'attachment' | null;
type Props = {
  layout?: 'dock' | 'workbench';
  session: AssistV3Session;
  profileName: string;
  catalog?: AssistModelCatalog;
  configurations: AssistConfiguration[];
  model: string;
  reasoning: string;
  configurationId: string;
  clarificationPolicy?: AssistClarificationPolicy;
  planNext: boolean;
  prompt: string;
  attachments: AssistAttachment[];
  selectedAttachments: string[];
  activeTurn: AssistV3Turn | null;
  busy: boolean;
  writeModeUnavailableReason: string | null;
  onModel: (value: string) => void;
  onReasoning: (value: string) => void;
  onConfiguration: (value: string) => void;
  onClarificationPolicy?: (value: AssistClarificationPolicy) => void;
  onPlanNext: (value: boolean) => void;
  onPrompt: (value: string) => void;
  onAttachments: (ids: string[]) => void;
  onAttachmentCreated: (item: AssistAttachment) => void;
  onAttachmentDeleted: (item: AssistAttachment, tombstone: boolean) => void;
  onSubmit: (behavior: FollowUp) => void;
  onStop: () => void;
  onTerminal: () => void;
  onCommand: (command: AssistCommand) => void;
  onSaveConfiguration: (name: string) => Promise<boolean>;
  onError: (message: string) => void;
};

type ComposerViewModel = {
  props: Props;
  root: RefObject<HTMLElement | null>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  fileInput: RefObject<HTMLInputElement | null>;
  selected: RefObject<string[]>;
  height: ReturnType<typeof useComposerHeight>;
  files: ReturnType<typeof useComposerFiles>;
  behavior: FollowUp;
  menu: ComposerMenu;
  saveOpen: boolean;
  configurationName: string;
  references: ReferenceCandidate[];
  referenceBusy: boolean;
  dragging: boolean;
  running: boolean;
  efforts: AssistModelCatalog['models'][number]['supportedReasoningEfforts'];
  token: ActiveToken | null;
  commands: Array<(typeof ASSIST_COMMANDS)[number]>;
  valid: boolean;
  setCaret: Dispatch<SetStateAction<number>>;
  setMenu: Dispatch<SetStateAction<ComposerMenu>>;
  setSaveOpen: Dispatch<SetStateAction<boolean>>;
  setConfigurationName: Dispatch<SetStateAction<string>>;
  setDragging: Dispatch<SetStateAction<boolean>>;
  chooseBehavior: (value: FollowUp) => void;
  submit: () => void;
  chooseReference: (item: ReferenceCandidate) => Promise<void>;
  chooseCommand: (command: AssistCommand) => void;
  paste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  openSave: () => void;
  save: () => Promise<void>;
  addInlineAttachment: (kind: 'url' | 'text') => Promise<void>;
};

export function AssistComposer(props: Props) {
  const [behavior, setBehavior] = useState<FollowUp>(readFollowUpBehavior);
  const [menu, setMenu] = useState<ComposerMenu>(null),
    [saveOpen, setSaveOpen] = useState(false),
    [configurationName, setConfigurationName] = useState('');
  const [caret, setCaret] = useState(0),
    [referenceBusy, setReferenceBusy] = useState(false),
    [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    selected = useRef(props.selectedAttachments),
    ide = useIdeContext();
  const height = useComposerHeight(root),
    running = Boolean(props.activeTurn),
    modelEntry = props.catalog?.models?.find((item) => item.model === props.model),
    efforts = modelEntry?.supportedReasoningEfforts || [];
  const token = activeComposerToken(props.prompt, caret),
    commands = token?.kind === 'command' ? ASSIST_COMMANDS.filter(([name]) => name.startsWith(token.query)) : [];
  const [references, setReferences] = useComposerReferences(props.session.id, token, ide.path, ide.selection);
  const valid = Boolean(props.model && props.reasoning && props.prompt.trim()),
    uploadingIds = (id: string) => {
      selected.current = [...new Set([...selected.current, id])];
      props.onAttachments(selected.current);
    };
  const files = useComposerFiles(props.session.id, props.onAttachmentCreated, uploadingIds, props.onError);
  useEffect(() => {
    selected.current = props.selectedAttachments;
  }, [props.selectedAttachments]);
  useEffect(() => {
    if (!menu && !saveOpen && !references.length && !commands.length) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        setReferences([]);
        setSaveOpen(false);
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [menu, saveOpen, references.length, commands.length]);
  function chooseBehavior(value: FollowUp) {
    setBehavior(value);
    sessionStorage.setItem('aiws-follow-up-behavior', value);
  }
  function submit() {
    if (valid && !files.uploading && !referenceBusy) props.onSubmit(behavior);
  }
  function replaceToken() {
    if (!token) return;
    const next = removeComposerToken(props.prompt, token);
    props.onPrompt(next);
    setReferences([]);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(token.start, token.start);
      setCaret(token.start);
    });
  }
  async function chooseReference(item: ReferenceCandidate) {
    if (!item.available || !token) return;
    setReferenceBusy(true);
    try {
      if (item.kind === 'uploaded_file') uploadingIds(item.reference_id);
      else {
        const body =
          item.kind === 'current_editor_selection'
            ? {
                kind: 'selection',
                path: item.path,
                text: item.selection?.text,
                selection: item.selection,
                title: item.title
              }
            : { kind: 'project_file', path: item.path || item.reference_id, title: item.title };
        const created = await api<AssistAttachment>(
          `/assist/v3/sessions/${props.session.id}/attachments`,
          json('POST', body, '添加智能助手引用')
        );
        props.onAttachmentCreated(created);
        uploadingIds(created.id);
      }
      replaceToken();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setReferenceBusy(false);
    }
  }
  function chooseCommand(command: AssistCommand) {
    if (!token) return;
    replaceToken();
    if (command === 'plan') props.onPlanNext(true);
    else if (command === 'model' || command === 'reasoning') setMenu(command);
    else if (command === 'terminal') props.onTerminal();
    else props.onCommand(command);
  }
  async function paste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData('text');
    if (text.length < LONG_PASTE_THRESHOLD) return;
    event.preventDefault();
    const start = event.currentTarget.selectionStart,
      end = event.currentTarget.selectionEnd,
      original = props.prompt;
    try {
      await files.upload(
        new File([text], `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, { type: 'text/plain' })
      );
    } catch {
      const restored = `${original.slice(0, start)}${text}${original.slice(end)}`;
      props.onPrompt(restored);
      requestAnimationFrame(() => textarea.current?.setSelectionRange(start + text.length, start + text.length));
    }
  }
  function openSave() {
    setConfigurationName(
      `${props.profileName} · ${props.model} · ${reasoningEffortLabel(props.reasoning)}`.slice(0, 100)
    );
    setSaveOpen(true);
  }
  async function save() {
    if (configurationName.trim() && (await props.onSaveConfiguration(configurationName.trim()))) {
      setSaveOpen(false);
      setMenu(null);
    }
  }
  async function addInlineAttachment(kind: 'url' | 'text') {
    const added = await addComposerInlineAttachment(kind, props.session.id, files, props, uploadingIds);
    if (added) setMenu(null);
  }
  const model: ComposerViewModel = {
    props,
    root,
    textarea,
    fileInput,
    selected,
    height,
    files,
    behavior,
    menu,
    saveOpen,
    configurationName,
    references,
    referenceBusy,
    dragging,
    running,
    efforts,
    token,
    commands,
    valid,
    setCaret,
    setMenu,
    setSaveOpen,
    setConfigurationName,
    setDragging,
    chooseBehavior,
    submit,
    chooseReference,
    chooseCommand,
    paste,
    openSave,
    save,
    addInlineAttachment
  };
  return <AssistComposerView model={model} />;
}

function AssistComposerView({ model }: { model: ComposerViewModel }) {
  const {
    props,
    root,
    textarea,
    fileInput,
    selected,
    height,
    files,
    behavior,
    menu,
    saveOpen,
    configurationName,
    references,
    referenceBusy,
    dragging,
    running,
    efforts,
    token,
    commands,
    valid,
    setCaret,
    setMenu,
    setSaveOpen,
    setConfigurationName,
    setDragging,
    chooseBehavior,
    submit,
    chooseReference,
    chooseCommand,
    paste,
    openSave,
    save,
    addInlineAttachment
  } = model;
  return (
    <section
      ref={root}
      className={`assist-composer-v3 layout-${props.layout || 'workbench'}${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void files.uploadDrop([...event.dataTransfer.files]);
      }}
    >
      <div
        className={`composer-height-handle${height.dragging ? ' dragging' : ''}`}
        role="separator"
        aria-label="调整输入区高度"
        aria-orientation="horizontal"
        aria-valuemin={84}
        aria-valuemax={Math.round(height.available)}
        aria-valuenow={Math.round(height.height || root.current?.getBoundingClientRect().height || 0)}
        tabIndex={0}
        data-tooltip="拖动调整输入区高度，双击恢复自动高度"
        {...height.handlers}
      >
        <GripHorizontal size={14} />
      </div>
      {props.writeModeUnavailableReason && (
        <div className="composer-readonly-status" role="status">
          <LockKeyhole size={12} />
          <span>代码工作区只读：{props.writeModeUnavailableReason}</span>
        </div>
      )}
      <ComposerInputArea model={model} />
      <ComposerAttachments model={model} />
      <ComposerControls model={model} />
    </section>
  );
}

function ComposerControls({ model }: { model: ComposerViewModel }) {
  const {
    props,
    fileInput,
    menu,
    setMenu,
    efforts,
    saveOpen,
    configurationName,
    setConfigurationName,
    setSaveOpen,
    openSave,
    save,
    addInlineAttachment,
    running,
    behavior,
    chooseBehavior,
    files,
    referenceBusy,
    valid,
    submit
  } = model;
  return (
    <footer className="codex-composer-controls">
      <div className="composer-native-controls">
        <button
          type="button"
          className="composer-text-control"
          aria-expanded={menu === 'model'}
          onClick={() => setMenu(menu === 'model' ? null : 'model')}
        >
          {props.model || '选择模型'}
        </button>
        <button
          type="button"
          className="composer-text-control"
          aria-label="推理强度"
          aria-expanded={menu === 'reasoning'}
          onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')}
        >
          {props.reasoning ? reasoningEffortLabel(props.reasoning) : '推理强度'}
        </button>
        <div className="clarification-segment" role="group" aria-label="澄清方式">
          <span>澄清方式</span>
          <button
            type="button"
            aria-pressed={(props.clarificationPolicy || 'ask') === 'ask'}
            className={(props.clarificationPolicy || 'ask') === 'ask' ? 'active' : ''}
            onClick={() => props.onClarificationPolicy?.('ask')}
          >
            问我
          </button>
          <button
            type="button"
            aria-pressed={props.clarificationPolicy === 'auto_recommend'}
            className={props.clarificationPolicy === 'auto_recommend' ? 'active' : ''}
            onClick={() => props.onClarificationPolicy?.('auto_recommend')}
          >
            自动推荐
          </button>
        </div>
        <button
          type="button"
          className={`composer-plan-toggle${props.planNext ? ' active' : ''}`}
          aria-pressed={props.planNext}
          onClick={() => props.onPlanNext(!props.planNext)}
        >
          <ListTodo size={13} />
          规划
        </button>
        <IconButton
          label="添加需求文档、设计稿或参考链接"
          className="composer-icon-control"
          active={menu === 'attachment'}
          onClick={() => setMenu(menu === 'attachment' ? null : 'attachment')}
        >
          <Paperclip size={14} />
        </IconButton>
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          multiple
          aria-label="选择附件"
          onChange={(event) => {
            void files.uploadDrop([...(event.target.files || [])]);
            event.currentTarget.value = '';
            setMenu(null);
          }}
        />
        <IconButton label="打开终端" className="composer-icon-control" onClick={props.onTerminal}>
          <TerminalSquare size={14} />
        </IconButton>
        <ComposerMenus model={model} />
      </div>
      {running && (
        <select
          aria-label="后续消息处理方式"
          value={behavior}
          onChange={(event) => chooseBehavior(event.target.value as FollowUp)}
        >
          <option value="queue">排队等待</option>
          <option value="steer">调整当前方向</option>
          <option value="interrupt">中断并接管</option>
        </select>
      )}
      {running && (
        <button className="button danger" onClick={props.onStop}>
          <Ban size={14} />
          停止
        </button>
      )}
      <button
        className="button primary"
        aria-label={running ? followUpLabel(behavior) : '发送'}
        disabled={(!running && props.busy) || files.uploading || referenceBusy || !valid}
        onClick={submit}
      >
        <Send size={14} />
        {running ? followUpLabel(behavior) : '发送'}
      </button>
    </footer>
  );
}

function ComposerInputArea({ model }: { model: ComposerViewModel }) {
  const {
    props,
    height,
    textarea,
    setCaret,
    paste,
    running,
    submit,
    references,
    commands,
    token,
    referenceBusy,
    chooseReference,
    chooseCommand
  } = model;
  return (
    <div className="composer-input-area" style={height.height ? { height: height.height } : undefined}>
      <textarea
        ref={textarea}
        aria-label="智能助手消息"
        value={props.prompt}
        onChange={(event) => {
          props.onPrompt(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => void paste(event)}
        placeholder={props.planNext ? '描述要规划的目标' : running ? '添加后续消息' : '输入消息，使用 @ 引用或 / 命令'}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
        }}
      />
      {(references.length > 0 || commands.length > 0) && (
        <div
          className="composer-token-menu"
          role="listbox"
          aria-label={token?.kind === 'reference' ? '引用候选' : '命令'}
        >
          {references.map((item) => (
            <button
              key={item.id}
              disabled={!item.available || referenceBusy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void chooseReference(item)}
            >
              <strong>{item.title}</strong>
              <small>
                {referenceKindLabel(item.kind)}
                {item.path ? ` · ${item.path}` : ''}
              </small>
            </button>
          ))}
          {commands.map(([name, label]) => (
            <button key={name} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(name)}>
              <strong>/{name}</strong>
              <small>{label}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ComposerAttachments({ model }: { model: ComposerViewModel }) {
  const { props, selected, files } = model;
  return (
    <>
      <AttachmentTray
        attachments={props.attachments}
        selectedIds={props.selectedAttachments}
        onSelected={(ids) => {
          selected.current = ids;
          props.onAttachments(ids);
        }}
        onDeleted={props.onAttachmentDeleted}
        onError={props.onError}
      />
      {files.uploads.length > 0 && (
        <div className="composer-uploads" aria-live="polite">
          {files.uploads.map((item) => (
            <span className={item.status} key={item.id}>
              {item.name} · {item.status === 'uploading' ? '上传中' : item.error}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function ComposerMenus({ model }: { model: ComposerViewModel }) {
  const {
    props,
    fileInput,
    menu,
    setMenu,
    efforts,
    saveOpen,
    configurationName,
    setConfigurationName,
    setSaveOpen,
    openSave,
    save,
    addInlineAttachment
  } = model;
  if (menu === 'model')
    return (
      <div className="composer-native-menu model-menu" role="menu" aria-label="Codex 模型">
        {(props.catalog?.models || []).map((item) => (
          <button
            role="menuitemradio"
            aria-checked={item.model === props.model}
            key={item.id}
            onClick={() => {
              props.onModel(item.model);
              setMenu(null);
            }}
          >
            <span>
              <strong>{item.displayName}</strong>
              <small>{modelDescriptionLabel(item.description)}</small>
            </span>
            {item.model === props.model && <Check size={13} />}
          </button>
        ))}
        {props.configurations.map((item) => (
          <button
            role="menuitemradio"
            aria-checked={item.id === props.configurationId}
            key={item.id}
            onClick={() => {
              props.onConfiguration(item.id);
              setMenu(null);
            }}
          >
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.model} · {reasoningEffortLabel(item.reasoning)}
              </small>
            </span>
            {item.id === props.configurationId && <Check size={13} />}
          </button>
        ))}
        <button className="menu-save" onClick={openSave}>
          <Save size={13} />
          保存当前配置
        </button>
        {saveOpen && (
          <div className="save-configuration">
            <input
              autoFocus
              aria-label="配置名称"
              value={configurationName}
              onChange={(event) => setConfigurationName(event.target.value)}
            />
            <IconButton label="取消保存配置" onClick={() => setSaveOpen(false)}>
              <X size={13} />
            </IconButton>
            <IconButton label="确认保存配置" onClick={() => void save()}>
              <Check size={13} />
            </IconButton>
          </div>
        )}
      </div>
    );
  if (menu === 'reasoning')
    return (
      <div className="composer-native-menu reasoning-menu" role="menu" aria-label="Codex 推理强度">
        {efforts.map((item) => (
          <button
            role="menuitemradio"
            aria-checked={item.reasoningEffort === props.reasoning}
            key={item.reasoningEffort}
            onClick={() => {
              props.onReasoning(item.reasoningEffort);
              setMenu(null);
            }}
          >
            <span>
              <strong>{reasoningEffortLabel(item.reasoningEffort)}</strong>
              <small>{reasoningEffortDescription(item.reasoningEffort, item.description)}</small>
            </span>
            {item.reasoningEffort === props.reasoning && <Check size={13} />}
          </button>
        ))}
      </div>
    );
  if (menu === 'attachment')
    return (
      <div className="composer-native-menu attachment-menu" role="menu" aria-label="添加材料">
        <button role="menuitem" onClick={() => fileInput.current?.click()}>
          <FileUp size={14} />
          <span>
            <strong>文件</strong>
            <small>需求文档、设计稿或模板</small>
          </span>
        </button>
        <button role="menuitem" onClick={() => void addInlineAttachment('url')}>
          <LinkIcon size={14} />
          <span>
            <strong>参考链接</strong>
            <small>添加 HTTPS 来源</small>
          </span>
        </button>
        <button role="menuitem" onClick={() => void addInlineAttachment('text')}>
          <ClipboardPaste size={14} />
          <span>
            <strong>粘贴文本</strong>
            <small>长文本将自动作为文件上传</small>
          </span>
        </button>
      </div>
    );
  return null;
}

function useComposerReferences(
  sessionId: string,
  token: ActiveToken | null,
  editorPath: string,
  selection: EditorSelection | null
) {
  const [references, setReferences] = useState<ReferenceCandidate[]>([]);
  useEffect(() => {
    if (token?.kind !== 'reference') {
      setReferences([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<ReferenceCandidate[]>(
        `/assist/v3/sessions/${sessionId}/references?q=${encodeURIComponent(token.query)}`,
        { signal: controller.signal }
      )
        .then((items) => {
          const local = editorReferenceCandidates(editorPath, selection);
          setReferences([...local, ...items.filter((item) => !local.some((entry) => entry.id === item.id))]);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token?.kind, token?.query, sessionId, editorPath, selection]);
  return [references, setReferences] as const;
}

function editorReferenceCandidates(editorPath: string, selection: EditorSelection | null): ReferenceCandidate[] {
  if (!editorPath) return [];
  const file: ReferenceCandidate = {
    id: `editor:${editorPath}`,
    reference_id: editorPath,
    kind: 'current_editor_file',
    title: editorPath,
    path: editorPath,
    available: true
  };
  if (!selection?.text) return [file];
  return [
    file,
    {
      id: `selection:${editorPath}`,
      reference_id: editorPath,
      kind: 'current_editor_selection',
      title: `${editorPath} · 选区`,
      path: editorPath,
      available: true,
      selection
    }
  ];
}

async function addComposerInlineAttachment(
  kind: 'url' | 'text',
  sessionId: string,
  files: ReturnType<typeof useComposerFiles>,
  props: Props,
  onSelected: (id: string) => void
) {
  const value = window.prompt(kind === 'url' ? '输入 HTTPS 参考链接' : '粘贴需求、说明或参考文本');
  if (!value?.trim()) return false;
  try {
    if (kind === 'text' && value.length >= LONG_PASTE_THRESHOLD) {
      await files.upload(
        new File([value], `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, { type: 'text/plain' })
      );
    } else {
      const item = await api<AssistAttachment>(
        `/assist/v3/sessions/${sessionId}/attachments`,
        json(
          'POST',
          kind === 'url'
            ? { kind, url: value.trim(), title: new URL(value.trim()).hostname }
            : { kind, text: value, title: '粘贴文本' },
          '添加智能助手附件'
        )
      );
      props.onAttachmentCreated(item);
      onSelected(item.id);
    }
    return true;
  } catch (error) {
    props.onError((error as Error).message);
    return false;
  }
}

function followUpLabel(value: FollowUp) {
  return value === 'interrupt' ? '中断并接管' : value === 'steer' ? '调整当前方向' : '加入队列';
}
function readFollowUpBehavior(): FollowUp {
  const value = sessionStorage.getItem('aiws-follow-up-behavior');
  return value === 'steer' || value === 'interrupt' ? value : 'queue';
}
