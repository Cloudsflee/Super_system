import Editor from '@monaco-editor/react';
import { Diff, File, Folder, FolderUp, Play, RefreshCw, Save, TestTube2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, json } from '../../../api/client';
import type { ChangeProposal, FileEntry } from '../../../api/types';
import type { RendererProps } from '../registry';
import { useUi } from '../../../state/ui';
import '../../../monaco';
import { useAssistSurface } from '../../../components/assist/semantic-actions';
import { useIdeContext } from '../../../state/ide-context';

type Tab = { path: string; content: string; saved: string; language: string };
type FileContent = { path: string; content: string; language: string };

export function ExecutionWorkspace({ value, onSaved }: RendererProps) {
  const [directory, setDirectory] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState('');
  const [output, setOutput] = useState('');
  const [task, setTask] = useState('test');
  const [runningNode, setRunningNode] = useState(false);
  const ui = useUi();
  const toast = ui.toast;
  const repositoryRoot = String(value.project.repo_path || value.project.workspace_root || '').trim();
  const repositoryBound = Boolean(repositoryRoot);
  useAssistSurface({ id: 'execution-workspace', filters: { 'execution.test_task': { label: '测试任务', elementId: 'execution-test-task', values: ['test', 'typecheck', 'lint', 'build'], set: (input) => { const value = String(input); if (['test', 'typecheck', 'lint', 'build'].includes(value)) setTask(value); } } } });
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ proposal?: ChangeProposal; applied?: { type?: string; node_id?: string } }>).detail;
      if (detail?.applied?.type === 'node_run_authorization' && detail.applied.node_id === value.node.id && detail.proposal?.id) void executeApproved(detail.proposal.id);
    };
    window.addEventListener('aiws:proposal-applied', listener);
    return () => window.removeEventListener('aiws:proposal-applied', listener);
  }, [value.node.id]);
  const files = useQuery({ queryKey: ['files', value.project.id, directory], queryFn: () => api<{ entries: FileEntry[] }>(`/projects/${value.project.id}/files?path=${encodeURIComponent(directory)}`), enabled: repositoryBound, retry: false });
  const repositoryAvailable = repositoryBound && files.isSuccess;
  const fileEntries = files.data?.entries || [];
  const current = tabs.find((tab) => tab.path === active);
  useEffect(() => {
    if (current) useIdeContext.getState().setFile(current.path, current.content);
    else useIdeContext.getState().clear();
  }, [current?.path, current?.content]);
  useEffect(() => () => useIdeContext.getState().clear(), []);
  async function open(entry: FileEntry) {
    if (!repositoryAvailable) return;
    if (entry.type === 'directory') { setDirectory(entry.path); return; }
    const existing = tabs.find((tab) => tab.path === entry.path);
    if (existing) { setActive(existing.path); return; }
    try { const file = await api<FileContent>(`/projects/${value.project.id}/files/content?path=${encodeURIComponent(entry.path)}`); setTabs((items) => [...items, { path: file.path, content: file.content, saved: file.content, language: file.language }]); setActive(file.path); } catch (error) { toast((error as Error).message, 'error'); }
  }
  function change(content = '') { setTabs((items) => items.map((tab) => tab.path === active ? { ...tab, content } : tab)); }
  function close(path: string) { const next = tabs.filter((tab) => tab.path !== path); setTabs(next); if (active === path) setActive(next.at(-1)?.path || ''); }
  async function save() {
    if (!repositoryAvailable || !current) return;
    try { await api(`/projects/${value.project.id}/files/content`, json('PUT', { path: current.path, content: current.content, node_id: value.node.id })); setTabs((items) => items.map((tab) => tab.path === active ? { ...tab, saved: tab.content } : tab)); await onSaved(); toast('文件已保存并记录 Trace'); } catch (error) { toast((error as Error).message, 'error'); }
  }
  async function diff() { if (!repositoryAvailable) return; try { const result = await api<{ diff: string }>(`/projects/${value.project.id}/files/diff?path=${encodeURIComponent(current?.path || '')}`); setOutput(result.diff || '没有未提交差异'); } catch (error) { toast((error as Error).message, 'error'); } }
  async function runTask() { if (!repositoryAvailable) return; try { const result = await api<{ task: { status: string; stdout: string; stderr: string } }>(`/projects/${value.project.id}/test-tasks`, json('POST', { preset: task, node_id: value.node.id })); setOutput(`[${result.task.status}]\n${result.task.stdout}\n${result.task.stderr}`.trim()); await onSaved(); } catch (error) { toast((error as Error).message, 'error'); } }
  async function runNode() {
    if (!repositoryAvailable) return;
    try {
      const proposal = await api<ChangeProposal>('/change-proposals', json('POST', { project_id: value.project.id, workspace_id: value.workspace.id, node_id: value.node.id, change_type: 'node_run_write', title: `运行节点：${value.node.title}`, summary: 'Codex 将在 workspace-write 隔离容器中执行，可能修改 repository 文件', before: null, after: { runner: 'codex_docker' }, impact: ['Repository 文件', 'NodeRun 资产与 Trace'], risks: ['模型可能产生非预期文件变更'], apply_action: { type: 'node_run_authorization', node_id: value.node.id, runner: 'codex_docker' } }));
      setOutput('等待用户批准并应用 NodeRun 变更提案'); ui.showProposal(proposal.id);
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  async function executeApproved(approvalId: string) { setRunningNode(true); try { const result = await api<{ run: { id: string; status: string; summary: string } }>(`/nodes/${value.node.id}/run/start`, json('POST', { runner: 'codex_docker', approval_id: approvalId })); setOutput(`[${result.run.status}] NodeRun ${result.run.id} 已启动；可在“运行与 Trace”中查看或停止。`); await onSaved(); } catch (error) { toast((error as Error).message, 'error'); } finally { setRunningNode(false); } }
  return (
    <div className="execution-workspace">
      <aside className="file-explorer"><header><strong>文件</strong><button className="row-icon" aria-label="上一级目录" disabled={!directory || !repositoryBound} onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}><FolderUp size={16} /></button></header><div className="file-path">/{directory}</div><div className="file-list">
        {!repositoryBound && <FileCapabilityState>未绑定 Repository</FileCapabilityState>}
        {repositoryBound && files.isLoading && <FileCapabilityState>正在读取 Repository</FileCapabilityState>}
        {repositoryBound && files.isError && <FileCapabilityState error detail={files.error.message} retry={() => files.refetch()}>文件加载失败</FileCapabilityState>}
        {repositoryAvailable && !fileEntries.length && <FileCapabilityState>当前目录为空</FileCapabilityState>}
        {repositoryAvailable && fileEntries.map((entry) => <button key={entry.path} onClick={() => open(entry)}>{entry.type === 'directory' ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span></button>)}
      </div></aside>
      <section className="code-area"><div className="editor-tabs">{tabs.map((tab) => <div className={tab.path === active ? 'active' : ''} key={tab.path}><button onClick={() => setActive(tab.path)}><span>{tab.path.split('/').at(-1)}{tab.content !== tab.saved ? ' *' : ''}</span></button><button aria-label={`关闭 ${tab.path}`} onClick={() => close(tab.path)}><X size={12} /></button></div>)}</div><div className="editor-toolbar"><span>{current?.path || '未打开文件'}</span><button className="button secondary" disabled={!repositoryAvailable || !current} onClick={diff}><Diff size={14} />Diff</button><button className="button primary" disabled={!repositoryAvailable || !current || current.content === current.saved} onClick={save}><Save size={14} />保存</button></div><div className="monaco-host">{current ? <Editor path={current.path} language={current.language} value={current.content} onChange={change} onMount={(editor) => {
        useIdeContext.getState().setFile(current.path, editor.getValue());
        editor.onDidChangeCursorSelection(({ selection }) => {
          const text = editor.getModel()?.getValueInRange(selection) || '';
          useIdeContext.getState().setSelection(text ? { text, start_line: selection.startLineNumber, start_column: selection.startColumn, end_line: selection.endLineNumber, end_column: selection.endColumn } : null);
        });
      }} theme="vs" options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, wordWrap: 'on', scrollBeyondLastLine: false }} /> : <div className="quiet-empty"><File size={22} /><p>{repositoryAvailable ? '从文件树打开文件' : 'Repository 文件能力不可用'}</p></div>}</div>
        <div className="task-console"><header><select id="execution-test-task" aria-label="测试任务" value={task} disabled={!repositoryAvailable} onChange={(e) => setTask(e.target.value)}><option value="test">Test</option><option value="typecheck">Typecheck</option><option value="lint">Lint</option><option value="build">Build</option></select><button className="button secondary" disabled={!repositoryAvailable} onClick={runTask}><TestTube2 size={14} />运行任务</button><button className="button primary" disabled={runningNode || !repositoryAvailable} onClick={runNode}><Play size={14} />{runningNode ? 'Running' : 'Run'}</button></header><pre>{output || '等待任务输出'}</pre></div>
      </section>
    </div>
  );
}

function FileCapabilityState({ children, detail, error = false, retry }: { children: string; detail?: string; error?: boolean; retry?: () => unknown }) {
  return <div className={`file-capability-state${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><File size={18} /><strong>{children}</strong>{detail && <small>{detail}</small>}{retry && <button className="row-icon" aria-label="重新加载文件" onClick={retry}><RefreshCw size={14} /></button>}</div>;
}
