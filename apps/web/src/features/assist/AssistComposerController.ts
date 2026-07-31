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
import type { AssistAttachment } from '../../api/types';
import { reasoningEffortLabel } from '../../components/common/display-labels';
import { useIdeContext, type EditorSelection } from '../../state/ide-context';
import type { AssistComposerProps, ComposerMenu, ComposerViewModel, FollowUp } from './AssistComposer';
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

export function useAssistComposerModel(props: AssistComposerProps): ComposerViewModel {
  const [behavior, setBehavior] = useState<FollowUp>(readFollowUpBehavior),
    [menu, setMenu] = useState<ComposerMenu>(null),
    [saveOpen, setSaveOpen] = useState(false),
    [configurationName, setConfigurationName] = useState('');
  const [caret, setCaret] = useState(0),
    [referenceBusy, setReferenceBusy] = useState(false),
    [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    selected = useRef(props.selectedAttachments),
    ide = useIdeContext(),
    height = useComposerHeight(root),
    running = Boolean(props.activeTurn),
    modelEntry = props.catalog?.models?.find((item) => item.model === props.model),
    efforts = modelEntry?.supportedReasoningEfforts || [],
    token = activeComposerToken(props.prompt, caret),
    commands = token?.kind === 'command' ? ASSIST_COMMANDS.filter(([name]) => name.startsWith(token.query)) : [];
  const [references, setReferences] = useComposerReferences(props.session.id, token, ide.path, ide.selection),
    valid = Boolean(props.model && props.reasoning && props.prompt.trim()),
    uploadingIds = (id: string) => {
      selected.current = [...new Set([...selected.current, id])];
      props.onAttachments(selected.current);
    },
    files = useComposerFiles(props.session.id, props.onAttachmentCreated, uploadingIds, props.onError);
  useSelectedAttachmentSync(selected, props.selectedAttachments);
  useComposerDismissal(menu, saveOpen, references.length, commands.length, setMenu, setReferences, setSaveOpen);
  const interactions = useComposerInteractions({
    props,
    behavior,
    setBehavior,
    valid,
    files,
    referenceBusy,
    setReferenceBusy,
    token,
    setReferences,
    textarea,
    setCaret,
    uploadingIds,
    configurationName,
    setConfigurationName,
    setSaveOpen,
    setMenu
  });
  return {
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
    ...interactions
  };
}

type ComposerInteractionContext = Pick<
  ComposerViewModel,
  | 'props'
  | 'behavior'
  | 'valid'
  | 'files'
  | 'referenceBusy'
  | 'token'
  | 'textarea'
  | 'configurationName'
  | 'setCaret'
  | 'setConfigurationName'
  | 'setSaveOpen'
  | 'setMenu'
> & {
  setBehavior: Dispatch<SetStateAction<FollowUp>>;
  setReferenceBusy: Dispatch<SetStateAction<boolean>>;
  setReferences: Dispatch<SetStateAction<ReferenceCandidate[]>>;
  uploadingIds: (id: string) => void;
};

function useComposerInteractions(context: ComposerInteractionContext) {
  const { props, files, token, textarea } = context;
  function chooseBehavior(value: FollowUp) {
    context.setBehavior(value);
    sessionStorage.setItem('aiws-follow-up-behavior', value);
  }
  function submit() {
    if (context.valid && !files.uploading && !context.referenceBusy) props.onSubmit(context.behavior);
  }
  function replaceToken() {
    if (!token) return;
    props.onPrompt(removeComposerToken(props.prompt, token));
    context.setReferences([]);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(token.start, token.start);
      context.setCaret(token.start);
    });
  }
  async function chooseReference(item: ReferenceCandidate) {
    if (!item.available || !token) return;
    context.setReferenceBusy(true);
    try {
      await applyComposerReference(item, props, context.uploadingIds);
      replaceToken();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      context.setReferenceBusy(false);
    }
  }
  function chooseCommand(command: AssistCommand) {
    if (!token) return;
    replaceToken();
    if (command === 'plan') props.onPlanNext(true);
    else if (command === 'model' || command === 'reasoning') context.setMenu(command);
    else if (command === 'terminal') props.onTerminal();
    else props.onCommand(command);
  }
  async function paste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    await pasteComposerText(event, files, props, textarea);
  }
  function openSave() {
    context.setConfigurationName(
      `${props.profileName} · ${props.model} · ${reasoningEffortLabel(props.reasoning)}`.slice(0, 100)
    );
    context.setSaveOpen(true);
  }
  async function save() {
    if (context.configurationName.trim() && (await props.onSaveConfiguration(context.configurationName.trim()))) {
      context.setSaveOpen(false);
      context.setMenu(null);
    }
  }
  async function addInlineAttachment(kind: 'url' | 'text') {
    const added = await addComposerInlineAttachment(kind, props.session.id, files, props, context.uploadingIds);
    if (added) context.setMenu(null);
  }
  return { chooseBehavior, submit, chooseReference, chooseCommand, paste, openSave, save, addInlineAttachment };
}

function useSelectedAttachmentSync(selected: RefObject<string[]>, selectedAttachments: string[]) {
  useEffect(() => {
    selected.current = selectedAttachments;
  }, [selectedAttachments, selected]);
}

function useComposerDismissal(
  menu: ComposerMenu,
  saveOpen: boolean,
  referenceCount: number,
  commandCount: number,
  setMenu: (value: ComposerMenu) => void,
  setReferences: (value: ReferenceCandidate[]) => void,
  setSaveOpen: (value: boolean) => void
) {
  useEffect(() => {
    if (!menu && !saveOpen && !referenceCount && !commandCount) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      setReferences([]);
      setSaveOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [menu, saveOpen, referenceCount, commandCount, setMenu, setReferences, setSaveOpen]);
}

async function applyComposerReference(
  item: ReferenceCandidate,
  props: AssistComposerProps,
  onSelected: (id: string) => void
) {
  if (item.kind === 'uploaded_file') return onSelected(item.reference_id);
  const body =
      item.kind === 'current_editor_selection'
        ? {
            kind: 'selection',
            path: item.path,
            text: item.selection?.text,
            selection: item.selection,
            title: item.title
          }
        : { kind: 'project_file', path: item.path || item.reference_id, title: item.title },
    created = await api<AssistAttachment>(
      `/assist/v3/sessions/${props.session.id}/attachments`,
      json('POST', body, '添加智能助手引用')
    );
  props.onAttachmentCreated(created);
  onSelected(created.id);
}

async function pasteComposerText(
  event: ReactClipboardEvent<HTMLTextAreaElement>,
  files: ReturnType<typeof useComposerFiles>,
  props: AssistComposerProps,
  textarea: RefObject<HTMLTextAreaElement | null>
) {
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
    const controller = new AbortController(),
      timer = setTimeout(() => {
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
  props: AssistComposerProps,
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

function readFollowUpBehavior(): FollowUp {
  const value = sessionStorage.getItem('aiws-follow-up-behavior');
  return value === 'steer' || value === 'interrupt' ? value : 'queue';
}
