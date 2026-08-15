import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeChange, applyNodeChanges
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Check, CircleAlert, History, LoaderCircle, Play, RefreshCw, RotateCcw, Save, ShieldCheck, Square, Workflow as WorkflowIcon } from 'lucide-react';
import { ApiError, api, mutate, shortHash } from '../../api';
import type { PageKey } from '../../App';
import type {
  NodeContract, Project, WorkflowCandidate, WorkflowGeneration, WorkflowLayoutRevision,
  WorkflowProposal, WorkflowTask, WorkflowWorkstream
} from '../../types';

export interface WorkflowPageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: PageKey) => void;
  setupReady: boolean;
  refreshSetup: () => Promise<void>;
}

type DraftView = NonNullable<Project['workflow_draft']> & { graph?: WorkflowCandidate | Record<string, never> };
type GenerationEvent = { cursor: number; type: string; created_at: string; data?: { status?: string; error_code?: string } };
type FlowData = { task: WorkflowTask; lane: string; selected: boolean };
type OperationReceipt = { operation_id: string; status: string; error_code?: string | null };

const FALLBACK_TASKS: WorkflowTask[] = [
  { id: 'inspect', title: 'Inspect repository', goal: 'Inspect brief and repository', level: 1, deps: [], mode: 'read', inputs: [], outputs: ['artifacts/analysis.json'], acceptance: ['analysis exists'], allowed_tools: [] },
  { id: 'write', title: 'Write change', goal: 'Implement and verify', level: 2, deps: ['inspect'], mode: 'write', inputs: ['artifacts/analysis.json'], outputs: ['artifacts/result.json'], acceptance: ['tests pass'], allowed_tools: ['git', 'test'] }
];

function ready(project?: Project) {
  return Boolean(project && project.status === 'active' && project.onboarding_state === 'confirmed' && project.intake?.status === 'ready' && (project.confirmed_brief_revision || project.brief_head?.confirmed_revision));
}

function statusTone(status: string) {
  if (['completed', 'passed', 'applied'].includes(status)) return 'positive';
  if (['queued', 'running', 'critic_pending', 'pending'].includes(status)) return 'working';
  if (['failed', 'rejected', 'cancelled', 'stale'].includes(status)) return 'negative';
  return 'neutral';
}

function Status({ value }: { value: string }) {
  return <span className={`status ${statusTone(value)}`}><span />{value.replaceAll('_', ' ')}</span>;
}

function TaskNode({ data }: { data: FlowData }) {
  return <div className={`flow-task-node ${data.selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <span className={data.task.mode === 'write' ? 'task-mode write' : 'task-mode'}>{data.task.mode}</span>
    <strong>{data.task.title}</strong>
    <small>{data.lane} / {data.task.id}</small>
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { task: TaskNode };

async function waitOperation(operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await api<OperationReceipt>(`/api/v1/operations/${operationId}`);
    if (['completed', 'failed', 'cancelled'].includes(operation.status)) {
      if (operation.status !== 'completed') throw new Error(operation.error_code || `Operation ${operation.status}`);
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Operation timed out');
}

function candidateFrom(project?: Project, draft?: DraftView | null, generation?: WorkflowGeneration | null): WorkflowCandidate {
  const generated = generation?.proposal?.candidate && 'workstreams' in generation.proposal.candidate ? generation.proposal.candidate as WorkflowCandidate : null;
  const graph = draft?.graph && 'workstreams' in draft.graph ? draft.graph as WorkflowCandidate : null;
  if (generated) return generated;
  if (graph) return graph;
  const tasks = project?.workflow?.tasks?.length ? project.workflow.tasks : FALLBACK_TASKS;
  const first = tasks.filter((task) => task.level === 1);
  const second = tasks.filter((task) => task.level === 2);
  const workstreams: WorkflowWorkstream[] = [
    { id: 'plan', title: 'Plan', deps: [], tasks: first.length ? first : tasks.slice(0, 1) },
    { id: 'delivery', title: 'Delivery', deps: ['plan'], tasks: second.length ? second : tasks.slice(1) }
  ].filter((lane) => lane.tasks.length);
  return { hierarchy_mode: 'two_level', name: project?.workflow?.name || 'Delivery workflow', workstreams, tasks };
}

function defaultPosition(laneIndex: number, taskIndex: number, compact = false) {
  return { x: compact ? 22 + laneIndex * 160 : 40 + laneIndex * 330, y: 64 + taskIndex * 112 };
}

function flowModel(candidate: WorkflowCandidate, layout: WorkflowLayoutRevision | null, selectedId: string, compact = false) {
  const saved = new Map((layout?.nodes || []).map((node) => [node.id, node.position]));
  const nodes: Node<FlowData>[] = [];
  for (const [laneIndex, lane] of candidate.workstreams.entries()) {
    for (const [taskIndex, task] of lane.tasks.entries()) {
      nodes.push({ id: task.id, type: 'task', position: compact ? defaultPosition(laneIndex, taskIndex, true) : saved.get(task.id) || defaultPosition(laneIndex, taskIndex), data: { task, lane: lane.title, selected: task.id === selectedId } });
    }
  }
  const edges: Edge[] = candidate.tasks.flatMap((task) => task.deps.map((dependency) => ({ id: `${dependency}-${task.id}`, source: dependency, target: task.id, animated: false, className: 'workflow-edge' })));
  return { nodes, edges };
}

function inspectorTask(candidate: WorkflowCandidate, id: string) {
  return candidate.tasks.find((task) => task.id === id) || candidate.tasks[0];
}

function ContractInspector({ task, contract }: { task?: WorkflowTask; contract?: NodeContract }) {
  if (!task) return <div className="workflow-empty-compact">Select a task</div>;
  const value = contract?.contract;
  return <div className="contract-inspector">
    <div className="contract-head"><span className={task.mode === 'write' ? 'task-mode write' : 'task-mode'}>{task.mode}</span><code>{task.id}</code></div>
    <h3>{task.title}</h3>
    <label className="contract-title-field"><span>Task title</span><input value={task.title} readOnly aria-label="Task title" /></label>
    <p>{value?.goal || task.goal || 'No goal recorded'}</p>
    <dl>
      <div><dt>Depends on</dt><dd>{(value?.dependencies || task.deps).join(', ') || 'none'}</dd></div>
      <div><dt>Inputs</dt><dd>{(value?.inputs || task.inputs).map((item) => typeof item === 'string' ? item : `${item.name}:${item.type}`).join(', ') || 'none'}</dd></div>
      <div><dt>Outputs</dt><dd>{(value?.outputs || task.outputs).map((item) => typeof item === 'string' ? item : `${item.name}:${item.type}`).join(', ') || 'none'}</dd></div>
      <div><dt>Tools</dt><dd>{(value?.allowed_tools || task.allowed_tools || []).join(', ') || 'none'}</dd></div>
      <div><dt>Acceptance</dt><dd>{(value?.acceptance || task.acceptance || []).join('; ') || 'none'}</dd></div>
    </dl>
  </div>;
}

export function WorkflowPage({ projectId, selectedProject, navigate, notify }: WorkflowPageProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [layouts, setLayouts] = useState<WorkflowLayoutRevision[]>([]);
  const [generations, setGenerations] = useState<WorkflowGeneration[]>([]);
  const [selectedGenerationId, setSelectedGenerationId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [contracts, setContracts] = useState<NodeContract[]>([]);
  const [events, setEvents] = useState<GenerationEvent[]>([]);
  const [nodes, setNodes] = useState<Node<FlowData>[]>([]);
  const [busy, setBusy] = useState('');
  const [fault, setFault] = useState('');
  const [compactFlow, setCompactFlow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 760);
  const selectedGeneration = generations.find((item) => item.id === selectedGenerationId) || generations[0] || null;

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [bundle, draftView, layoutRows, generationRows] = await Promise.all([
        api<Project>(`/api/v1/projects/${projectId}`),
        api<DraftView>(`/api/v1/projects/${projectId}/workflow-draft`),
        api<WorkflowLayoutRevision[]>(`/api/v1/projects/${projectId}/workflow-draft/layouts`),
        api<WorkflowGeneration[]>(`/api/v1/projects/${projectId}/workflow-generations`)
      ]);
      const safeLayouts = Array.isArray(layoutRows) ? layoutRows : [];
      const safeGenerations = Array.isArray(generationRows) ? generationRows : [];
      setProject(bundle); setDraft(draftView); setLayouts(safeLayouts); setGenerations(safeGenerations); setFault('');
      setSelectedGenerationId((current) => safeGenerations.some((item) => item.id === current) ? current : safeGenerations[0]?.id || '');
      const revision = bundle.workflow?.revision;
      const contractRows = revision ? await api<NodeContract[]>(`/api/v1/projects/${projectId}/node-contracts?workflow_revision=${revision}`) : [];
      setContracts(Array.isArray(contractRows) ? contractRows : []);
    } catch (error) { setFault(error instanceof Error ? error.message : 'Workflow data failed'); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onResize = () => setCompactFlow(window.innerWidth <= 760);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!selectedGenerationId) { setEvents([]); return; }
    void api<GenerationEvent[]>(`/api/v1/workflow-generations/${selectedGenerationId}/events`).then(setEvents).catch(() => setEvents([]));
  }, [selectedGenerationId, generations]);
  useEffect(() => {
    if (!selectedGenerationId || !selectedGeneration || !['queued', 'running', 'critic_pending'].includes(selectedGeneration.phase)) return;
    const timer = setInterval(() => void load(), 650);
    return () => clearInterval(timer);
  }, [load, selectedGeneration, selectedGenerationId]);

  const candidate = useMemo(() => candidateFrom(project || selectedProject, draft, selectedGeneration), [draft, project, selectedGeneration, selectedProject]);
  const selectedLayout = layouts.find((item) => item.revision === draft?.layout_revision) || layouts[0] || null;
  const model = useMemo(() => flowModel(candidate, selectedLayout, selectedTaskId, compactFlow), [candidate, selectedLayout, selectedTaskId, compactFlow]);
  useEffect(() => { setNodes(model.nodes); setSelectedTaskId((current) => candidate.tasks.some((task) => task.id === current) ? current : candidate.tasks[0]?.id || ''); }, [candidate.hash, candidate.tasks.length, model.nodes.length, selectedLayout?.id]);
  useEffect(() => { setNodes((rows) => rows.map((node) => ({ ...node, data: { ...node.data, selected: node.id === selectedTaskId } }))); }, [selectedTaskId]);
  const task = inspectorTask(candidate, selectedTaskId);
  const contract = contracts.find((item) => item.node_id === task?.id);
  const projectReady = ready(project || selectedProject);

  if (!projectId) return <div className="empty-state"><WorkflowIcon size={28} /><h2>No project selected</h2><button className="button primary" onClick={() => navigate('projects')}>Open projects</button></div>;

  const run = async (mode: 'initial' | 'replan' = 'initial') => {
    setBusy(mode); setFault('');
    try {
      const receipt = mode === 'replan'
        ? await mutate<{ generation_id: string }>(`/api/v1/projects/${projectId}/workflow-generations/replan`, { provider: 'fixture', async: true, completed_node_ids: [] })
        : await mutate<{ generation_id: string }>(`/api/v1/projects/${projectId}/workflow-generations`, { provider: 'fixture', async: true });
      setSelectedGenerationId(receipt.generation_id); await load(); notify(mode === 'replan' ? 'Replan queued' : 'Generation queued');
    } catch (error) { const message = error instanceof Error ? error.message : 'Generation failed'; setFault(message); notify(message, 'error'); }
    finally { setBusy(''); }
  };
  const saveLayout = async () => {
    if (!draft) return;
    setBusy('layout');
    try {
      await mutate(`/api/v1/projects/${projectId}/workflow-draft/layouts`, { expected_revision: draft.layout_revision || 0, draft_revision: draft.revision, nodes: nodes.map((node) => ({ id: node.id, position: node.position })), viewport: selectedLayout?.viewport || { x: 0, y: 0, zoom: 1 } });
      await load(); notify('Layout revision saved');
    } catch (error) { notify(error instanceof Error ? error.message : 'Layout failed', 'error'); }
    finally { setBusy(''); }
  };
  const apply = async (proposal?: WorkflowProposal) => {
    if (!proposal) return;
    setBusy('apply');
    try {
      const receipt = await mutate<OperationReceipt>(`/api/v1/workflow-proposals/${proposal.id}/apply`, { async: true });
      if (receipt.operation_id) await waitOperation(receipt.operation_id);
      await load(); notify('Workflow revision applied');
    }
    catch (error) { const message = error instanceof ApiError && error.code === 'workflow_proposal_stale' ? 'Proposal is stale. Generate again.' : error instanceof Error ? error.message : 'Apply failed'; setFault(message); notify(message, 'error'); }
    finally { setBusy(''); }
  };
  const retry = async () => {
    if (!selectedGeneration) return;
    setBusy('retry');
    try { const receipt = await mutate<{ generation_id: string }>(`/api/v1/workflow-generations/${selectedGeneration.id}/retry`, { provider: 'fixture' }); setSelectedGenerationId(receipt.generation_id); await load(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Retry failed', 'error'); }
    finally { setBusy(''); }
  };
  const cancel = async () => {
    if (!selectedGeneration?.operation_id) return;
    setBusy('cancel');
    try {
      const operation = await api<{ revision: number }>(`/api/v1/operations/${selectedGeneration.operation_id}`);
      await mutate(`/api/v1/workflow-generations/${selectedGeneration.id}/cancel`, { expected_revision: operation.revision }); await load();
    } catch (error) { notify(error instanceof Error ? error.message : 'Cancel failed', 'error'); }
    finally { setBusy(''); }
  };
  const onNodesChange = (changes: NodeChange<Node<FlowData>>[]) => setNodes((current) => applyNodeChanges(changes, current));

  return <div className="page workflow-page-r4">
    <div className="page-heading workflow-heading"><div><p className="eyebrow">{project?.name || selectedProject?.name}</p><h1>Workflow</h1></div><div className="workflow-heading-actions"><span className="pin"><span>Draft</span>r{draft?.revision || 0}</span><span className="pin"><span>Applied</span>r{project?.workflow?.revision || 0}</span><button className="button primary" disabled={!projectReady || Boolean(busy)} onClick={() => void run()}>{busy === 'initial' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Generate</button></div></div>
    {!projectReady && <div className="project-readiness"><CircleAlert size={17} /><div><strong>Project onboarding pending</strong><span>{project?.onboarding_state || selectedProject?.onboarding_state}</span></div></div>}
    {fault && <div className="workflow-fault" role="alert"><CircleAlert size={16} /><span>{fault}</span><button className="icon-button" title="重新加载" aria-label="重新加载" onClick={() => void load()}><RefreshCw size={15} /></button></div>}

    <div className="workflow-commandbar">
      <div><strong>{candidate.name}</strong><span>{candidate.workstreams.length} workstreams / {candidate.tasks.length} tasks</span></div>
      <div className="workflow-command-actions"><button className="icon-button" title="保存布局" aria-label="保存布局" disabled={!draft || busy === 'layout'} onClick={() => void saveLayout()}><Save size={16} /></button><button className="button" disabled={!projectReady || Boolean(busy)} onClick={() => void run('replan')}><RotateCcw size={15} />Replan</button></div>
    </div>

    <div className="workflow-main-grid">
      <section className="workflow-canvas-shell" aria-label="Workflow canvas">
        <div className="workflow-lane-strip">{candidate.workstreams.map((lane) => <span key={lane.id}><strong>{lane.title}</strong><small>{lane.tasks.length} tasks</small></span>)}</div>
        {typeof ResizeObserver !== 'undefined' ? <ReactFlowProvider><ReactFlow
          key={`${compactFlow ? 'compact' : 'full'}-${candidate.hash || candidate.tasks.length}`}
          nodes={nodes} edges={model.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setSelectedTaskId(node.id)} fitView minZoom={0.35} maxZoom={1.8}
          proOptions={{ hideAttribution: true }} nodesConnectable={false} nodesFocusable
        ><Background gap={20} size={1} color="#d9dfdb" /><MiniMap pannable zoomable nodeColor={(node) => (node.data as FlowData).task.mode === 'write' ? '#d5a958' : '#4d8c79'} /><Controls showInteractive={false} /></ReactFlow></ReactFlowProvider> : <div className="workflow-static-lanes">{candidate.workstreams.map((lane) => <div key={lane.id}><span>{lane.title}</span>{lane.tasks.map((item) => <button key={item.id} className={item.id === selectedTaskId ? 'dag-task selected' : 'dag-task'} onClick={() => setSelectedTaskId(item.id)}><span className={item.mode === 'write' ? 'task-mode write' : 'task-mode'}>{item.mode}</span><strong>{item.title}</strong><small>{item.id}</small></button>)}</div>)}</div>}
      </section>

      <aside className="workflow-inspector-panel"><div className="workflow-panel-head"><div><ShieldCheck size={15} /><strong>Node Contract</strong></div><span>r{project?.workflow?.revision || 0}</span></div><ContractInspector task={task} contract={contract} /></aside>

      <aside className="workflow-generation-panel">
        <div className="workflow-panel-head"><div><History size={15} /><strong>Generation</strong></div><span>{generations.length}</span></div>
        <div className="generation-list">{generations.map((item) => <button key={item.id} className={item.id === selectedGeneration?.id ? 'generation-row selected' : 'generation-row'} onClick={() => setSelectedGenerationId(item.id)}><span><strong>Attempt {item.attempt}</strong><small>{shortHash(item.id)}</small></span><Status value={item.phase} /></button>)}{!generations.length && <div className="workflow-empty-compact">No generations</div>}</div>
        {selectedGeneration && <div className="generation-detail"><div className="generation-meta"><Status value={selectedGeneration.phase} /><code>{shortHash(selectedGeneration.candidate_hash)}</code></div>{selectedGeneration.error_code && <p className="fault-code">{selectedGeneration.error_code}</p>}{selectedGeneration.critic && <div className="critic-receipt"><span>Critic</span><strong>{selectedGeneration.critic.status || 'not run'}</strong>{Array.isArray(selectedGeneration.critic.issues) && selectedGeneration.critic.issues.map((issue, index) => <small key={index}>{typeof issue === 'string' ? issue : issue.code}</small>)}</div>}<div className="generation-actions">{['queued', 'running', 'critic_pending'].includes(selectedGeneration.phase) && <button className="button" disabled={busy === 'cancel'} onClick={() => void cancel()}><Square size={14} />Cancel</button>}{['failed', 'rejected', 'cancelled'].includes(selectedGeneration.phase) && <button className="button" disabled={busy === 'retry'} onClick={() => void retry()}><RefreshCw size={14} />Retry</button>}{selectedGeneration.proposal?.status === 'pending' && <button className="button primary" disabled={!projectReady || busy === 'apply'} onClick={() => void apply(selectedGeneration.proposal)}><Check size={14} />Apply</button>}</div></div>}
        <div className="generation-events">{events.slice(-6).map((event) => <div key={event.cursor}><span /><p>{event.type.replace('workflow.generation.', '')}</p><small>#{event.cursor}</small></div>)}</div>
      </aside>
    </div>
  </div>;
}
