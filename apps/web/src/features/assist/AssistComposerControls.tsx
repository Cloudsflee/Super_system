import {
  Ban,
  Check,
  ClipboardPaste,
  FileUp,
  Link as LinkIcon,
  ListTodo,
  Paperclip,
  Save,
  Send,
  TerminalSquare,
  X
} from 'lucide-react';

import { IconButton } from '../../components/common/IconButton';
import {
  modelDescriptionLabel,
  reasoningEffortDescription,
  reasoningEffortLabel
} from '../../components/common/display-labels';
import type { ComposerViewModel, FollowUp } from './AssistComposer';

export function ComposerControls({ model }: { model: ComposerViewModel }) {
  return (
    <footer className="codex-composer-controls">
      <ComposerNativeControls model={model} />
      <ComposerRunControls model={model} />
    </footer>
  );
}

function ComposerNativeControls({ model }: { model: ComposerViewModel }) {
  const { props, fileInput, menu, setMenu, files } = model;
  return (
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
      <ClarificationControls model={model} />
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
      <ComposerMenu model={model} />
    </div>
  );
}

function ClarificationControls({ model: { props } }: { model: ComposerViewModel }) {
  const policy = props.clarificationPolicy || 'ask';
  return (
    <div className="clarification-segment" role="group" aria-label="澄清方式">
      <span>澄清方式</span>
      <button
        type="button"
        aria-pressed={policy === 'ask'}
        className={policy === 'ask' ? 'active' : ''}
        onClick={() => props.onClarificationPolicy?.('ask')}
      >
        问我
      </button>
      <button
        type="button"
        aria-pressed={policy === 'auto_recommend'}
        className={policy === 'auto_recommend' ? 'active' : ''}
        onClick={() => props.onClarificationPolicy?.('auto_recommend')}
      >
        自动推荐
      </button>
    </div>
  );
}

function ComposerRunControls({ model }: { model: ComposerViewModel }) {
  const { props, running, behavior, chooseBehavior, files, referenceBusy, valid, submit } = model;
  return (
    <>
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
    </>
  );
}

function ComposerMenu({ model }: { model: ComposerViewModel }) {
  if (model.menu === 'model') return <ModelMenu model={model} />;
  if (model.menu === 'reasoning') return <ReasoningMenu model={model} />;
  if (model.menu === 'attachment') return <AttachmentMenu model={model} />;
  return null;
}

function ModelMenu({ model }: { model: ComposerViewModel }) {
  const { props, setMenu, saveOpen, configurationName, setConfigurationName, setSaveOpen, openSave, save } = model;
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
}

function ReasoningMenu({ model }: { model: ComposerViewModel }) {
  const { props, efforts, setMenu } = model;
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
}

function AttachmentMenu({ model }: { model: ComposerViewModel }) {
  const { fileInput, addInlineAttachment } = model;
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
}

function followUpLabel(value: FollowUp) {
  return value === 'interrupt' ? '中断并接管' : value === 'steer' ? '调整当前方向' : '加入队列';
}
