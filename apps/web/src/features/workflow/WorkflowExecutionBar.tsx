import { useQuery } from '@tanstack/react-query';
import { GitBranch, Play } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type {
  ProjectBundle,
  RepositoryBranchCatalog,
  RepositoryConnection,
  TaskExecutionRecord,
  Workflow,
  WorkflowExecutionList,
  WorkflowExecutionSnapshot,
  WorkflowOutcomeSnapshot
} from '../../api/types';
import { useUi } from '../../state/ui';
import { WorkflowExecutionSummary } from './WorkflowExecutionSummary';
import { WorkflowOutcomePanel } from './WorkflowOutcomePanel';
import { QualityReviewPolicyEditor } from './QualityReviewPolicyEditor';

type Selection = { connection_id: string; base_ref: string };

export function WorkflowExecutionBar({
  bundle,
  workflow,
  canWrite,
  onRefresh,
  onSnapshot
}: {
  bundle: ProjectBundle;
  workflow: Workflow;
  canWrite: boolean;
  onRefresh: () => void;
  onSnapshot: (value: WorkflowExecutionSnapshot | null) => void;
}) {
  const [configuring, setConfiguring] = useState(false),
    [busy, setBusy] = useState(''),
    [outcomesOpen, setOutcomesOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const toast = useUi((state) => state.toast);
  const history = useQuery({
    queryKey: ['workflow-executions', workflow.id],
    queryFn: () => api<WorkflowExecutionList>(`/workflows/${workflow.id}/executions`),
    refetchInterval: (query) =>
      ['running', 'paused'].includes(query.state.data?.current?.workflow_execution.status || '') ? 1_000 : 4_000
  });
  const connections = useQuery({
    queryKey: ['repository-connections', bundle.project.id],
    queryFn: () => api<{ items: RepositoryConnection[] }>(`/projects/${bundle.project.id}/repository-connections`)
  });
  const repositoryWorkstreams = useMemo(() => repositoryStreams(bundle), [bundle]);
  useEffect(() => {
    const first = connections.data?.items?.[0];
    if (!first) return;
    setSelections((current) =>
      Object.fromEntries(
        repositoryWorkstreams.map((item) => [
          item.id,
          current[item.id] || { connection_id: first.id, base_ref: first.default_branch || 'main' }
        ])
      )
    );
  }, [connections.data, repositoryWorkstreams]);
  const snapshot = history.data?.current,
    execution = snapshot?.workflow_execution;
  const outcomes = useQuery({
    queryKey: ['workflow-outcomes', execution?.id],
    queryFn: () => api<WorkflowOutcomeSnapshot>(`/workflow-executions/${execution!.id}/outcomes`),
    enabled: Boolean(execution && outcomesOpen),
    refetchInterval: execution?.completion_status === 'pending' ? 2_000 : false
  });
  useEffect(() => onSnapshot(snapshot || null), [onSnapshot, snapshot]);
  const tasks = useMemo(() => latestTasks(snapshot?.task_executions || []), [snapshot?.task_executions]);
  async function start() {
    if (repositoryWorkstreams.some((item) => !selections[item.id]?.connection_id || !selections[item.id]?.base_ref))
      return toast('请选择每条仓库执行线的代码仓库和分支', 'error');
    setBusy('start');
    try {
      await api(
        `/workflows/${workflow.id}/executions`,
        json(
          'POST',
          {
            expected_workflow_revision: Number(workflow.workflow_revision || workflow.version || 1),
            repositories: repositoryWorkstreams.map((item) => ({ workstream_id: item.id, ...selections[item.id] }))
          },
          {
            name: '启动工作流',
            feedback: 'foreground',
            idempotencyKey: `workflow-${workflow.id}-${crypto.randomUUID()}`,
            timeoutMs: 120_000
          }
        )
      );
      setConfiguring(false);
      await history.refetch().then(() => onRefresh());
      toast('工作流已启动');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }
  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (!execution) return;
    setBusy(action);
    try {
      await api(`/workflow-executions/${execution.id}/${action}`, json('POST', {}, `${actionLabel(action)}工作流`));
      await history.refetch();
      onRefresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }
  const openConfiguration = () => (repositoryWorkstreams.length ? setConfiguring(true) : void start());
  return (
    <section
      className="workflow-execution-band"
      aria-label="工作流执行"
      data-status={execution?.status || 'not_started'}
    >
      <WorkflowExecutionSummary
        snapshot={snapshot}
        execution={execution}
        tasks={tasks}
        lines={snapshot?.repository_lines || []}
        workflowRevision={Number(workflow.workflow_revision || workflow.version || 1)}
        outcomesOpen={outcomesOpen}
        canWrite={canWrite}
        busy={busy}
        onToggleOutcomes={() => setOutcomesOpen((value) => !value)}
        onStart={openConfiguration}
        onControl={control}
      />
      <ExecutionQualityPolicy workflow={workflow} canWrite={canWrite} execution={execution} onRefresh={onRefresh} />
      {execution && outcomesOpen && (
        <div id={`workflow-outcomes-${execution.id}`}>
          <WorkflowOutcomePanel
            executionId={execution.id}
            value={outcomes.data}
            loading={outcomes.isLoading}
            error={outcomes.error}
            canRun={canWrite}
            canApprove={(bundle.membership?.role || bundle.project.current_user_role) === 'owner'}
            onRefresh={async () => {
              await Promise.all([outcomes.refetch(), history.refetch()]);
              onRefresh();
            }}
          />
        </div>
      )}
      {configuring && (
        <WorkflowLineConfiguration
          projectId={bundle.project.id}
          streams={repositoryWorkstreams}
          connections={connections.data?.items || []}
          selections={selections}
          setSelections={setSelections}
          busy={busy}
          onCancel={() => setConfiguring(false)}
          onStart={() => void start()}
        />
      )}
    </section>
  );
}

function ExecutionQualityPolicy({
  workflow,
  canWrite,
  execution,
  onRefresh
}: {
  workflow: Workflow;
  canWrite: boolean;
  execution?: WorkflowExecutionSnapshot['workflow_execution'];
  onRefresh: () => void;
}) {
  const executionActive = Boolean(execution && !['completed', 'failed', 'cancelled'].includes(execution.status));
  return (
    <QualityReviewPolicyEditor
      workflow={workflow}
      canWrite={canWrite}
      executionActive={executionActive}
      onRefresh={onRefresh}
    />
  );
}

function WorkflowLineConfiguration({
  projectId,
  streams,
  connections,
  selections,
  setSelections,
  busy,
  onCancel,
  onStart
}: {
  projectId: string;
  streams: ReturnType<typeof repositoryStreams>;
  connections: RepositoryConnection[];
  selections: Record<string, Selection>;
  setSelections: Dispatch<SetStateAction<Record<string, Selection>>>;
  busy: string;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <div className="workflow-line-config">
      {streams.map((stream) => (
        <div key={stream.id} className="workflow-line-row">
          <span>
            <GitBranch size={14} />
            <strong>{stream.title}</strong>
          </span>
          <label>
            代码仓库
            <select
              value={selections[stream.id]?.connection_id || ''}
              onChange={(event) => {
                const connection = connections.find((item) => item.id === event.target.value);
                setSelections((current) => ({
                  ...current,
                  [stream.id]: { connection_id: event.target.value, base_ref: connection?.default_branch || 'main' }
                }));
              }}
            >
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.full_name || item.id}
                </option>
              ))}
            </select>
          </label>
          <BranchSelect
            projectId={projectId}
            selection={selections[stream.id]}
            onChange={(base_ref) =>
              setSelections((current) => ({ ...current, [stream.id]: { ...current[stream.id], base_ref } }))
            }
          />
        </div>
      ))}
      <div className="workflow-line-submit">
        <button className="button secondary" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={Boolean(busy) || connections.length === 0} onClick={onStart}>
          <Play size={15} />
          启动
        </button>
      </div>
    </div>
  );
}

function BranchSelect({
  projectId,
  selection,
  onChange
}: {
  projectId: string;
  selection?: Selection;
  onChange: (value: string) => void;
}) {
  const query = useQuery({
    queryKey: ['repository-branches', projectId, selection?.connection_id],
    queryFn: () =>
      api<RepositoryBranchCatalog>(
        `/projects/${projectId}/repository-branches?connection_id=${selection?.connection_id}`
      ),
    enabled: Boolean(selection?.connection_id)
  });
  useEffect(() => {
    if (query.data && !query.data.branches.some((item) => item.name === selection?.base_ref))
      onChange(query.data.default_branch);
  }, [onChange, query.data, selection?.base_ref]);
  return (
    <label>
      基准分支
      <select value={selection?.base_ref || ''} onChange={(event) => onChange(event.target.value)}>
        {query.data?.branches.map((item) => (
          <option key={item.full_ref} value={item.name}>
            {item.name} · {short(item.sha)}
          </option>
        )) || <option value={selection?.base_ref || 'main'}>{selection?.base_ref || 'main'}</option>}
      </select>
    </label>
  );
}

function repositoryStreams(bundle: ProjectBundle) {
  const tasks = bundle.nodes.filter(
    (item) => item.role === 'task' && ['code', 'test', 'integration', 'deploy'].includes(item.task_kind || '')
  );
  const ids = new Set(tasks.map((item) => item.parent_node_id));
  return bundle.nodes.filter((item) => item.role === 'workstream' && ids.has(item.id));
}
function latestTasks(items: TaskExecutionRecord[]) {
  const map = new Map<string, TaskExecutionRecord>();
  for (const item of items)
    if (!map.has(item.task_id) || Number(map.get(item.task_id)?.attempt) < item.attempt) map.set(item.task_id, item);
  return [...map.values()];
}
function actionLabel(value: string) {
  return ({ pause: '暂停', resume: '继续', cancel: '取消' } as Record<string, string>)[value] || '控制';
}
function short(value?: string | null) {
  return value ? value.slice(0, 10) : '待绑定';
}
