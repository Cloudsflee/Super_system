import { useRef, useState } from 'react';
import { apiV2, mutateV2 } from '../../api';
import { projectDeepLink, type WorkspacePageProps } from '../../workspace';
import type { ContextPack, RunnerProfile } from './workflowTypes';

export type ExecutionLaunchState = { phase: 'idle' | 'creating' | 'starting' | 'draft'; execution?: { id: string; revision: number; status?: string } };
export function ExecutionLauncher({ projectId, projectRevision, confirmed, saved, dirty, runners, packs, online, busy, navigate, navigateProject, onResult, onError }: {
  projectId: string; projectRevision: number; confirmed: boolean; saved: boolean; dirty: boolean;
  runners: RunnerProfile[]; packs: ContextPack[]; online: boolean; busy: boolean;
  navigate: WorkspacePageProps['navigate']; navigateProject: WorkspacePageProps['navigateProject'];
  onResult: (message: string, data?: Record<string, unknown>) => void; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<ExecutionLaunchState>({ phase: 'idle' });
  const [runnerId, setRunnerId] = useState(''); const [packId, setPackId] = useState('');
  const startKey = useRef(''); const createKey = useRef(''); const creatingInput = useRef<{ runner_profile_id: string; context_pack_id: string; revision: number } | null>(null);
  const runner = runners.find(item => item.id === runnerId && item.status === 'ready') || (!runnerId ? runners.find(item => item.status === 'ready') : undefined);
  const pack = packs.find(item => item.id === packId && item.status === 'sealed') || (!packId ? packs.find(item => item.status === 'sealed') : undefined);
  const reasons = [!online && '恢复连接后可用', !confirmed && '请先确认 Brief', !saved && '请先保存 Workflow', dirty && '请先保存或放弃本地修改', !pack && '请先生成 Context Pack', !runner && '需要就绪的 Runner Profile'].filter(Boolean);
  const open = (id: string) => { if (navigateProject) navigateProject(projectId, 'execution', { execution_id: id }); else window.location.hash = projectDeepLink(projectId, 'execution', { execution_id: id }); };
  const start = async (execution: NonNullable<ExecutionLaunchState['execution']>, retry = false) => {
    setState({ phase: 'starting', execution });
    try {
      if (retry) {
        const current = (await apiV2<{ execution: typeof execution }>(`/api/v2/executions/${encodeURIComponent(execution.id)}`)).data.execution;
        if (current.status && current.status !== 'draft') { onResult('执行状态已恢复'); open(execution.id); return; }
        execution = current;
      }
      startKey.current ||= crypto.randomUUID();
      const result = await mutateV2<Record<string, unknown>>(`/api/v2/executions/${encodeURIComponent(execution.id)}/start`, {}, 'POST', { expectedRevision: execution.revision, idempotencyKey: startKey.current });
      onResult('执行已创建并启动', result.data); open(execution.id);
    } catch (error) { setState({ phase: 'draft', execution }); onError(error); }
  };
  const launch = async () => {
    if (reasons.length || !runner || !pack || state.phase !== 'idle') return;
    setState({ phase: 'creating' });
    try {
      // Reuse the create request after an unknown network result to avoid a
      // second Draft Execution. Its pins and revision remain the original ones.
      createKey.current ||= crypto.randomUUID();
      creatingInput.current ||= { runner_profile_id: runner.id, context_pack_id: pack.id, revision: projectRevision };
      const { revision, ...input } = creatingInput.current;
      const result = await mutateV2<{ execution: NonNullable<ExecutionLaunchState['execution']> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`, input, 'POST', { expectedRevision: revision, idempotencyKey: createKey.current });
      if (!result.data.execution?.id || !Number.isInteger(result.data.execution.revision)) throw new Error('execution_receipt_invalid');
      await start(result.data.execution);
    } catch (error) { setState({ phase: 'idle' }); onError(error); }
  };
  return <section className="execution-launcher"><h3>开始执行</h3>
    <label><span>Runner Profile</span><select aria-label="Runner Profile" value={runnerId || runner?.id || ''} onChange={event => setRunnerId(event.target.value)} disabled={state.phase !== 'idle'}><option value="">选择就绪的 Profile</option>{runners.map(item => <option key={item.id} value={item.id} disabled={item.status !== 'ready'}>{item.label} · {item.status}</option>)}</select></label>
    <label><span>Context Pack</span><select aria-label="Context Pack" value={packId || pack?.id || ''} onChange={event => setPackId(event.target.value)} disabled={state.phase !== 'idle'}><option value="">选择已封存的 Pack</option>{packs.filter(item => item.status === 'sealed').map(item => <option key={item.id} value={item.id}>{item.pack_hash || item.id}</option>)}</select></label>
    {reasons.length > 0 && <ul className="prerequisite-note">{reasons.map(reason => <li key={String(reason)}>{reason}</li>)}</ul>}
    {!runner && <button className="button" onClick={() => navigate('runner')}>前往 Runner 设置</button>}
    {!pack && <button className="button" onClick={() => navigateProject ? navigateProject(projectId, 'context') : navigate('context')}>前往上下文</button>}
    <button className="button primary" disabled={busy || state.phase !== 'idle' || reasons.length > 0} onClick={() => void launch()}>创建并开始执行</button>
    {['creating', 'starting'].includes(state.phase) && <p role="status">{state.phase === 'creating' ? '正在创建执行' : '正在启动执行'}</p>}
    {state.phase === 'draft' && state.execution && <div role="alert"><p>Draft Execution {state.execution.id} 已保留。</p><button className="button" disabled={!online || busy} onClick={() => void start(state.execution!, true)}>重新启动</button><button className="button" onClick={() => open(state.execution!.id)}>查看 Draft Execution</button></div>}
  </section>;
}
