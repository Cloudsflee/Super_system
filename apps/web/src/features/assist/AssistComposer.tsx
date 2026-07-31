import { GripHorizontal, LockKeyhole } from 'lucide-react';
import { type ClipboardEvent as ReactClipboardEvent, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  AssistAttachment,
  AssistClarificationPolicy,
  AssistConfiguration,
  AssistModelCatalog,
  AssistV3Session,
  AssistV3Turn
} from '../../api/types';
import { referenceKindLabel } from '../../components/common/display-labels';
import { AttachmentTray } from './AttachmentTray';
import { ASSIST_COMMANDS, type ActiveToken, type AssistCommand, type ReferenceCandidate } from './composer-support';
import { useComposerFiles } from './useComposerFiles';
import { useComposerHeight } from './useComposerHeight';
import { ComposerControls } from './AssistComposerControls';
import { useAssistComposerModel } from './AssistComposerController';

export type FollowUp = 'queue' | 'steer' | 'interrupt';
export type ComposerMenu = 'model' | 'reasoning' | 'attachment' | null;
export type AssistComposerProps = {
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

export type ComposerViewModel = {
  props: AssistComposerProps;
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

export function AssistComposer(props: AssistComposerProps) {
  return <AssistComposerView model={useAssistComposerModel(props)} />;
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
