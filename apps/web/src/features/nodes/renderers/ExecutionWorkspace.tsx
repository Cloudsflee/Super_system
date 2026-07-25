import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Diff,
  ExternalLink,
  File,
  Folder,
  FolderUp,
  GitBranch,
  Layers3,
  Play,
  RefreshCw,
  Save,
  TestTube2,
  X
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { api, json } from '../../../api/client';
import type { FileEntry, RepositoryBranchCatalog, RepositoryConnection, RepositoryWorkspace } from '../../../api/types';
import type { RendererProps } from '../registry';
import { useUi, type UiState } from '../../../state/ui';
import '../../../monaco';
import { useAssistSurface } from '../../../components/assist/semantic-actions';
import { displayStatus, pullRequestStatusLabel } from '../../../components/common/display-labels';
import { useIdeContext } from '../../../state/ide-context';

export type ExecutionTab = { path: string; content: string; saved: string; language: string };
type FileContent = { path: string; content: string; language: string };
type WorkspaceList = { items: RepositoryWorkspace[] };
type ConnectionList = { items: RepositoryConnection[] };

export function ExecutionWorkspace({
  value,
  onSaved,
  onRunNode = () => undefined,
  runningNode = false
}: RendererProps) {
  const [connectionId, setConnectionId] = useState(''),
    [branchRef, setBranchRef] = useState(''),
    [workspaceId, setWorkspaceId] = useState('');
  const ui = useUi(),
    toast = ui.toast,
    projectId = value.project.id;
  const repositoryRoot = String(value.project.repo_path || value.project.workspace_root || '').trim(),
    repositoryBound = Boolean(repositoryRoot);
  const connections = useQuery({
    queryKey: ['repository-connections', projectId],
    queryFn: () => api<ConnectionList>(`/projects/${projectId}/repository-connections`),
    enabled: repositoryBound,
    retry: false
  });
  const workspaces = useQuery({
    queryKey: ['repository-workspaces', projectId],
    queryFn: () => api<WorkspaceList>(`/projects/${projectId}/repository-workspaces`),
    enabled: repositoryBound,
    retry: false
  });
  const branches = useQuery({
    queryKey: ['repository-branches', projectId, connectionId],
    queryFn: () =>
      api<RepositoryBranchCatalog>(
        `/projects/${projectId}/repository-branches${connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ''}`
      ),
    enabled: repositoryBound && connections.isFetched,
    retry: false
  });
  const availableWorkspaces = useMemo(
    () => (workspaces.data?.items || []).filter((item) => !connectionId || item.connection_id === connectionId),
    [workspaces.data, connectionId]
  );
  const selectedWorkspace = availableWorkspaces.find((item) => item.id === workspaceId) || null;
  const selectedBranch = branches.data?.branches.find((item) => item.ref === branchRef) || null;
  const preparation = useWorkspacePreparation({
    value,
    projectId,
    connectionId,
    selectedBranch,
    availableWorkspaces,
    workspaceId,
    setWorkspaceId,
    workspacesReady: workspaces.isSuccess,
    refetchWorkspaces: workspaces.refetch,
    toast
  });
  const requiresRepository =
    value.node.type === 'execution' ||
    value.contract?.expected_inputs?.some((item) => item.source === 'repository_workspace') ||
    ['code', 'test', 'deploy', 'integration'].includes(value.node.task_kind || '');
  const repositoryError = connections.error || workspaces.error || branches.error;

  useEffect(() => {
    const preferred =
      workspaces.data?.items.find((item) => item.id === value.project.default_repository_workspace_id) ||
      workspaces.data?.items[0];
    if (!connectionId) setConnectionId(preferred?.connection_id || connections.data?.items[0]?.id || '');
  }, [connections.data, workspaces.data, connectionId, value.project.default_repository_workspace_id]);
  useEffect(() => {
    if (!branches.data) return;
    if (branchRef && branches.data.branches.some((item) => item.ref === branchRef)) return;
    const preferred = availableWorkspaces.find((item) => item.id === value.project.default_repository_workspace_id);
    const defaultBranch = branches.data.branches.find(
      (item) => item.ref === branches.data.default_branch || item.name === branches.data.default_branch
    );
    preparation.reset(false);
    setWorkspaceId('');
    setBranchRef(
      (preferred && branches.data.branches.some((item) => item.ref === preferred.ref)
        ? preferred.ref
        : defaultBranch?.ref) ||
        branches.data.branches[0]?.ref ||
        ''
    );
  }, [branches.data, availableWorkspaces, branchRef, value.project.default_repository_workspace_id]);
  const editor = useExecutionEditor({ value, onSaved, selectedWorkspace, workspaceId, toast });

  async function refreshWorkspace() {
    preparation.retry();
    if (!selectedWorkspace) {
      preparation.reset(false);
      await Promise.all([branches.refetch(), workspaces.refetch()]);
      return;
    }
    try {
      await api(
        `/repository-workspaces/${selectedWorkspace.id}/refresh`,
        json('POST', { fetch: true }, '刷新代码仓库工作副本')
      );
      await Promise.all([branches.refetch(), workspaces.refetch()]);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  return (
    <ExecutionWorkspaceView
      connections={connections.data?.items || []}
      catalog={branches.data}
      workspaces={availableWorkspaces}
      connectionId={connectionId}
      branchRef={branchRef}
      workspaceId={workspaceId}
      selectedWorkspace={selectedWorkspace}
      repositoryBound={repositoryBound}
      repositoryError={repositoryError}
      branchCount={branches.data?.branches.length || 0}
      preparation={preparation}
      editor={editor}
      requiresRepository={requiresRepository}
      runningNode={runningNode}
      onConnection={(id) => {
        preparation.reset(false);
        setConnectionId(id);
        setBranchRef('');
        setWorkspaceId('');
      }}
      onBranch={(ref) => {
        preparation.reset(false);
        setBranchRef(ref);
        setWorkspaceId('');
      }}
      onWorkspace={(id) => {
        preparation.reset(true);
        setWorkspaceId(id);
      }}
      onRefresh={refreshWorkspace}
      onRetryRepository={() => Promise.all([connections.refetch(), workspaces.refetch(), branches.refetch()])}
      onRunNode={onRunNode}
    />
  );
}

function useWorkspacePreparation({
  value,
  projectId,
  connectionId,
  selectedBranch,
  availableWorkspaces,
  workspaceId,
  setWorkspaceId,
  workspacesReady,
  refetchWorkspaces,
  toast
}: {
  value: RendererProps['value'];
  projectId: string;
  connectionId: string;
  selectedBranch: RepositoryBranchCatalog['branches'][number] | null;
  availableWorkspaces: RepositoryWorkspace[];
  workspaceId: string;
  setWorkspaceId: (value: string) => void;
  workspacesReady: boolean;
  refetchWorkspaces: () => Promise<unknown>;
  toast: UiState['toast'];
}) {
  const [preparingKey, setPreparingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(new Set<string>());
  const activeKey = useRef<string | null>(null);
  const manualSelection = useRef(false);
  const selectedKey = selectedBranch ? workspaceAttemptKey(connectionId, selectedBranch.ref, selectedBranch.sha) : null;

  useEffect(() => {
    if (!selectedBranch || !workspacesReady) return;
    const currentWorkspace = availableWorkspaces.find((item) => item.id === workspaceId);
    if (manualSelection.current && currentWorkspace?.ref === selectedBranch.ref) return;
    manualSelection.current = false;
    const existing = pickCurrentWorkspace(
      availableWorkspaces,
      selectedBranch.ref,
      selectedBranch.sha,
      workspaceId,
      value.project.default_repository_workspace_id
    );
    if (existing) {
      activeKey.current = null;
      setPreparingKey(null);
      setError(null);
      if (existing.id !== workspaceId) setWorkspaceId(existing.id);
      return;
    }
    if (workspaceId) setWorkspaceId('');
    const key = workspaceAttemptKey(connectionId, selectedBranch.ref, selectedBranch.sha);
    if (value.project.current_user_role === 'viewer') {
      setError('只读角色无法为当前分支创建执行副本');
      return;
    }
    if (attempts.current.has(key)) return;
    attempts.current.add(key);
    activeKey.current = key;
    setPreparingKey(key);
    setError(null);
    void api<{ workspace: RepositoryWorkspace }>(
      `/projects/${projectId}/repository-workspaces`,
      json(
        'POST',
        {
          connection_id: connectionId || undefined,
          ref: selectedBranch.ref,
          expected_sha: selectedBranch.sha,
          mode: 'read_write',
          scope: { type: 'task', id: value.node.id, path_prefixes: ['.'] },
          operation_key: `web:${value.node.id}:${connectionId || 'default'}:${selectedBranch.ref}:${selectedBranch.sha}`
        },
        '准备当前分支'
      )
    )
      .then(async (result) => {
        await refetchWorkspaces();
        if (activeKey.current === key) {
          setWorkspaceId(result.workspace.id);
          setError(null);
          toast(`已准备 ${selectedBranch.name}@${shortSha(selectedBranch.sha)}`);
        }
      })
      .catch((reason: Error) => {
        if (activeKey.current === key) setError(reason.message);
      })
      .finally(() => {
        if (activeKey.current === key) {
          activeKey.current = null;
          setPreparingKey(null);
        }
      });
  }, [
    availableWorkspaces,
    connectionId,
    projectId,
    selectedBranch,
    toast,
    value.node.id,
    value.project.current_user_role,
    value.project.default_repository_workspace_id,
    workspaceId,
    workspacesReady
  ]);

  function reset(manual: boolean) {
    manualSelection.current = manual;
    activeKey.current = null;
    setPreparingKey(null);
    setError(null);
  }
  function retry() {
    if (selectedKey) attempts.current.delete(selectedKey);
    setError(null);
  }
  return { opening: Boolean(selectedKey && selectedKey === preparingKey), error, reset, retry };
}

function useExecutionEditor({
  value,
  onSaved,
  selectedWorkspace,
  workspaceId,
  toast
}: {
  value: RendererProps['value'];
  onSaved: RendererProps['onSaved'];
  selectedWorkspace: RepositoryWorkspace | null;
  workspaceId: string;
  toast: UiState['toast'];
}) {
  const [directory, setDirectory] = useState('');
  const [tabs, setTabs] = useState<ExecutionTab[]>([]);
  const [active, setActive] = useState('');
  const [output, setOutput] = useState('');
  const [task, setTask] = useState('test');
  const [saving, setSaving] = useState(false);
  const files = useQuery({
    queryKey: ['repository-workspace-files', selectedWorkspace?.id, directory],
    queryFn: () =>
      api<{ entries: FileEntry[] }>(
        `/repository-workspaces/${selectedWorkspace?.id}/files?path=${encodeURIComponent(directory)}`
      ),
    enabled: Boolean(selectedWorkspace?.id),
    retry: false
  });
  const repositoryAvailable = Boolean(selectedWorkspace && files.isSuccess);
  const writeEnabled = Boolean(
    repositoryAvailable && selectedWorkspace?.mode === 'read_write' && !selectedWorkspace.stale
  );
  const fileEntries = files.data?.entries || [];
  const current = tabs.find((tab) => tab.path === active);

  useEffect(() => {
    setDirectory('');
    setTabs([]);
    setActive('');
    setOutput('');
  }, [workspaceId]);
  useEffect(() => {
    if (current) useIdeContext.getState().setFile(current.path, current.content);
    else useIdeContext.getState().clear();
  }, [current?.path, current?.content]);
  useEffect(() => () => useIdeContext.getState().clear(), []);
  useAssistSurface({
    id: 'execution-workspace',
    revision: `${value.node.id}:${selectedWorkspace?.id || 'no-repository'}`,
    repository_workspace_id: selectedWorkspace?.id || null,
    filters: {
      'execution.test_task': {
        label: '测试任务',
        elementId: 'execution-test-task',
        values: ['test', 'typecheck', 'lint', 'build'],
        set: (input) => {
          const next = String(input);
          if (['test', 'typecheck', 'lint', 'build'].includes(next)) setTask(next);
        }
      }
    }
  });

  async function open(entry: FileEntry) {
    if (!repositoryAvailable) return;
    if (entry.type === 'directory') {
      setDirectory(entry.path);
      return;
    }
    const existing = tabs.find((tab) => tab.path === entry.path);
    if (existing) {
      setActive(existing.path);
      return;
    }
    try {
      const file = await api<FileContent>(
        `/repository-workspaces/${selectedWorkspace?.id}/files/content?path=${encodeURIComponent(entry.path)}`
      );
      setTabs((items) => [
        ...items,
        { path: file.path, content: file.content, saved: file.content, language: file.language }
      ]);
      setActive(file.path);
    } catch (reason) {
      toast((reason as Error).message, 'error');
    }
  }
  function change(content = '') {
    setTabs((items) => items.map((tab) => (tab.path === active ? { ...tab, content } : tab)));
  }
  function close(filePath: string) {
    const next = tabs.filter((tab) => tab.path !== filePath);
    setTabs(next);
    if (active === filePath) setActive(next.at(-1)?.path || '');
  }
  async function save() {
    if (!writeEnabled || !current || saving) return;
    const savedPath = current.path;
    const savedContent = current.content;
    setSaving(true);
    try {
      await api(
        `/repository-workspaces/${selectedWorkspace?.id}/files/content`,
        json('PUT', { path: savedPath, content: savedContent, node_id: value.node.id }, '保存工作副本文件')
      );
      setTabs((items) => markSavedSnapshot(items, savedPath, savedContent));
      await onSaved();
      toast('文件已保存并记录执行轨迹');
    } catch (reason) {
      toast((reason as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }
  async function diff() {
    if (!repositoryAvailable) return;
    try {
      const result = await api<{ diff: string }>(
        `/repository-workspaces/${selectedWorkspace?.id}/diff?path=${encodeURIComponent(current?.path || '')}`
      );
      setOutput(result.diff || '没有未提交差异');
    } catch (reason) {
      toast((reason as Error).message, 'error');
    }
  }
  async function runTask() {
    if (!writeEnabled) return;
    try {
      const result = await api<{ task: { status: string; stdout: string; stderr: string } }>(
        `/repository-workspaces/${selectedWorkspace?.id}/test-tasks`,
        json('POST', { preset: task, node_id: value.node.id }, '运行工作副本测试任务')
      );
      setOutput(`[${displayStatus(result.task.status)}]\n${result.task.stdout}\n${result.task.stderr}`.trim());
      await onSaved();
    } catch (reason) {
      toast((reason as Error).message, 'error');
    }
  }
  return {
    directory,
    setDirectory,
    tabs,
    active,
    setActive,
    output,
    task,
    setTask,
    saving,
    files,
    repositoryAvailable,
    writeEnabled,
    fileEntries,
    current,
    open,
    change,
    close,
    save,
    diff,
    runTask
  };
}

type ExecutionWorkspaceViewProps = {
  connections: RepositoryConnection[];
  catalog?: RepositoryBranchCatalog;
  workspaces: RepositoryWorkspace[];
  connectionId: string;
  branchRef: string;
  workspaceId: string;
  selectedWorkspace: RepositoryWorkspace | null;
  repositoryBound: boolean;
  repositoryError: Error | null;
  branchCount: number;
  preparation: ReturnType<typeof useWorkspacePreparation>;
  editor: ReturnType<typeof useExecutionEditor>;
  requiresRepository: boolean;
  runningNode: boolean;
  onConnection: (value: string) => void;
  onBranch: (value: string) => void;
  onWorkspace: (value: string) => void;
  onRefresh: () => void;
  onRetryRepository: () => Promise<unknown>;
  onRunNode: (repositoryWorkspaceId?: string) => void;
};

function ExecutionWorkspaceView(props: ExecutionWorkspaceViewProps) {
  return (
    <div className="execution-workspace">
      <RepositoryBar
        connections={props.connections}
        catalog={props.catalog}
        workspaces={props.workspaces}
        connectionId={props.connectionId}
        branchRef={props.branchRef}
        workspaceId={props.workspaceId}
        selected={props.selectedWorkspace}
        opening={props.preparation.opening}
        onConnection={props.onConnection}
        onBranch={props.onBranch}
        onWorkspace={props.onWorkspace}
        onRefresh={props.onRefresh}
      />
      <ExecutionFileExplorer {...props} />
      <ExecutionCodeArea {...props} />
    </div>
  );
}

function ExecutionFileExplorer(props: ExecutionWorkspaceViewProps) {
  const { editor, selectedWorkspace, repositoryBound, repositoryError, preparation, branchCount } = props;
  return (
    <aside className="file-explorer">
      <header>
        <strong>文件</strong>
        <button
          className="row-icon"
          aria-label="上一级目录"
          disabled={!editor.directory || !selectedWorkspace}
          onClick={() => editor.setDirectory(editor.directory.split('/').slice(0, -1).join('/'))}
        >
          <FolderUp size={16} />
        </button>
      </header>
      <div className="file-path">/{editor.directory}</div>
      <div className="file-list">
        {!repositoryBound && <FileCapabilityState>未绑定代码仓库</FileCapabilityState>}
        {repositoryBound && repositoryError && (
          <FileCapabilityState error detail={repositoryError.message} retry={props.onRetryRepository}>
            文件加载失败
          </FileCapabilityState>
        )}
        {repositoryBound && !repositoryError && !selectedWorkspace && preparation.error && (
          <FileCapabilityState error detail={preparation.error} retry={props.onRefresh}>
            当前分支没有可用执行副本
          </FileCapabilityState>
        )}
        {repositoryBound && !repositoryError && !selectedWorkspace && !preparation.error && (
          <FileCapabilityState>
            {preparation.opening || branchCount ? '正在准备当前分支' : '当前代码仓库没有可用分支'}
          </FileCapabilityState>
        )}
        {selectedWorkspace && editor.files.isLoading && <FileCapabilityState>正在读取代码仓库</FileCapabilityState>}
        {selectedWorkspace && editor.files.isError && (
          <FileCapabilityState error detail={editor.files.error.message} retry={() => editor.files.refetch()}>
            文件加载失败
          </FileCapabilityState>
        )}
        {editor.repositoryAvailable && !editor.fileEntries.length && (
          <FileCapabilityState>当前目录为空</FileCapabilityState>
        )}
        {editor.repositoryAvailable &&
          editor.fileEntries.map((entry) => (
            <button key={entry.path} onClick={() => editor.open(entry)}>
              {entry.type === 'directory' ? <Folder size={15} /> : <File size={15} />}
              <span>{entry.name}</span>
            </button>
          ))}
      </div>
    </aside>
  );
}

function ExecutionCodeArea(props: ExecutionWorkspaceViewProps) {
  const { editor, selectedWorkspace } = props;
  const current = editor.current;
  return (
    <section className="code-area">
      <div className="editor-tabs">
        {editor.tabs.map((tab) => (
          <div className={tab.path === editor.active ? 'active' : ''} key={tab.path}>
            <button onClick={() => editor.setActive(tab.path)}>
              <span>
                {tab.path.split('/').at(-1)}
                {tab.content !== tab.saved ? ' *' : ''}
              </span>
            </button>
            <button aria-label={`关闭 ${tab.path}`} onClick={() => editor.close(tab.path)}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="editor-toolbar">
        <span>{current?.path || '未打开文件'}</span>
        <button className="button secondary" disabled={!editor.repositoryAvailable || !current} onClick={editor.diff}>
          <Diff size={14} />
          差异
        </button>
        <button
          className="button primary"
          disabled={editor.saving || !editor.writeEnabled || !current || current.content === current.saved}
          onClick={editor.save}
        >
          <Save size={14} />
          {editor.saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="monaco-host">
        {current ? (
          <Editor
            path={`${selectedWorkspace?.id}/${current.path}`}
            language={current.language}
            value={current.content}
            onChange={editor.change}
            onMount={(instance) => bindEditorSelection(instance, current)}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              automaticLayout: true,
              wordWrap: 'on',
              scrollBeyondLastLine: false
            }}
          />
        ) : (
          <div className="quiet-empty">
            <File size={22} />
            <p>{editor.repositoryAvailable ? '从文件树打开文件' : '代码仓库文件能力不可用'}</p>
          </div>
        )}
      </div>
      <div className="task-console">
        <header>
          <select
            id="execution-test-task"
            aria-label="测试任务"
            value={editor.task}
            disabled={!editor.writeEnabled}
            onChange={(event) => editor.setTask(event.target.value)}
          >
            <option value="test">测试</option>
            <option value="typecheck">类型检查</option>
            <option value="lint">代码规范检查</option>
            <option value="build">生产构建</option>
          </select>
          <button className="button secondary" disabled={!editor.writeEnabled} onClick={editor.runTask}>
            <TestTube2 size={14} />
            运行任务
          </button>
          <button
            className="button primary"
            disabled={
              props.runningNode || Boolean(props.requiresRepository && (!editor.writeEnabled || !selectedWorkspace))
            }
            onClick={() => props.onRunNode(selectedWorkspace?.id)}
          >
            <Play size={14} />
            {props.runningNode ? '运行中' : '运行'}
          </button>
        </header>
        <pre>{editor.output || '等待任务输出'}</pre>
      </div>
    </section>
  );
}

function bindEditorSelection(
  editor: Parameters<NonNullable<ComponentProps<typeof Editor>['onMount']>>[0],
  tab: ExecutionTab
) {
  useIdeContext.getState().setFile(tab.path, editor.getValue());
  editor.onDidChangeCursorSelection(({ selection }) => {
    const text = editor.getModel()?.getValueInRange(selection) || '';
    useIdeContext.getState().setSelection(
      text
        ? {
            text,
            start_line: selection.startLineNumber,
            start_column: selection.startColumn,
            end_line: selection.endLineNumber,
            end_column: selection.endColumn
          }
        : null
    );
  });
}

function RepositoryBar(props: {
  connections: RepositoryConnection[];
  catalog?: RepositoryBranchCatalog;
  workspaces: RepositoryWorkspace[];
  connectionId: string;
  branchRef: string;
  workspaceId: string;
  selected: RepositoryWorkspace | null;
  opening: boolean;
  onConnection: (value: string) => void;
  onBranch: (value: string) => void;
  onWorkspace: (value: string) => void;
  onRefresh: () => void;
}) {
  const branchCopies = props.workspaces.filter((item) => item.ref === props.branchRef);
  return (
    <header className="repository-workspace-bar">
      <label>
        代码仓库
        <select
          aria-label="代码仓库"
          value={props.connectionId}
          onChange={(event) => props.onConnection(event.target.value)}
        >
          {!props.connections.length && <option value="">默认代码仓库</option>}
          {props.connections.map((item) => (
            <option value={item.id} key={item.id}>
              {item.full_name || item.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        分支
        <select aria-label="分支" value={props.branchRef} onChange={(event) => props.onBranch(event.target.value)}>
          {props.catalog?.branches.map((item) => (
            <option value={item.ref} key={item.full_ref}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button className="row-icon repository-refresh" aria-label="刷新当前分支" onClick={props.onRefresh}>
        <RefreshCw size={15} />
      </button>
      {branchCopies.length > 1 && (
        <details className="repository-workspace-copies">
          <summary aria-label="选择执行副本">
            <Layers3 size={14} />
            <span>执行副本</span>
          </summary>
          <div>
            <label>
              执行副本
              <select
                aria-label="执行副本"
                value={props.workspaceId}
                onChange={(event) => props.onWorkspace(event.target.value)}
              >
                {branchCopies.map((item) => (
                  <option value={item.id} key={item.id}>
                    {shortSha(item.fixed_sha)} · {item.mode === 'read_write' ? '可写' : '只读'}
                    {item.stale ? ' · 已过期' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      )}
      {props.opening && (
        <div className="repository-workspace-meta" role="status">
          正在准备当前分支
        </div>
      )}
      {!props.opening && props.selected && (
        <div className="repository-workspace-meta">
          <code>{shortSha(props.selected.current_sha)}</code>
          <span>{props.selected.mode === 'read_write' ? '可写' : '只读'}</span>
          <span>
            <GitBranch size={12} />
            领先 {props.selected.ahead}/落后 {props.selected.behind}
          </span>
          {props.selected.stale && (
            <span className="workspace-warning">
              <AlertTriangle size={12} />
              已过期
            </span>
          )}
          {props.selected.dirty && <span className="workspace-warning">有未提交变更</span>}
          {props.selected.pull_requests?.map((item) =>
            item.url ? (
              <a key={item.intent_id} href={item.url} target="_blank" rel="noreferrer">
                合并请求 #{item.number}
                <ExternalLink size={11} />
              </a>
            ) : (
              <span key={item.intent_id}>合并请求 {pullRequestStatusLabel(item.state)}</span>
            )
          )}
        </div>
      )}
    </header>
  );
}

export function markSavedSnapshot(tabs: ExecutionTab[], filePath: string, content: string) {
  return tabs.map((tab) => (tab.path === filePath ? { ...tab, saved: content } : tab));
}
function FileCapabilityState({
  children,
  detail,
  error = false,
  retry
}: {
  children: string;
  detail?: string;
  error?: boolean;
  retry?: () => unknown;
}) {
  return (
    <div className={`file-capability-state${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
      <File size={18} />
      <strong>{children}</strong>
      {detail && <small>{detail}</small>}
      {retry && (
        <button className="row-icon" aria-label="重新加载文件" onClick={retry}>
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}
function pickCurrentWorkspace(
  workspaces: RepositoryWorkspace[],
  ref: string,
  sha: string,
  currentId: string,
  defaultId?: string | null
) {
  return workspaces
    .filter((item) => item.ref === ref && item.fixed_sha === sha && !item.stale)
    .sort(
      (left, right) =>
        Number(right.id === currentId) - Number(left.id === currentId) ||
        Number(right.id === defaultId) - Number(left.id === defaultId) ||
        Date.parse(right.last_synced_at || '') - Date.parse(left.last_synced_at || '') ||
        right.revision - left.revision
    )[0];
}
function workspaceAttemptKey(connectionId: string, ref: string, sha: string) {
  return `${connectionId || 'default'}:${ref}:${sha}`;
}
function shortSha(value?: string | null) {
  return String(value || '').slice(0, 8) || '--------';
}
