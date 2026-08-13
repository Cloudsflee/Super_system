import { useEffect, useMemo, useState } from 'react';
import { Archive, Check, CircleAlert, Play, RefreshCw, RotateCcw, Square, Trash2, Undo2 } from 'lucide-react';
import { ApiError, api, formatTime, mutate, shortHash } from '../../api';
import type { Project } from '../../types';

export interface ProjectOnboardingProps {
  project: Project;
  onChanged: () => Promise<void>;
  notify: (message: string, tone?: 'ok' | 'error') => void;
}

type Operation = { operation_id: string; status: string; revision?: number; error_code?: string | null };

export function ProjectOnboarding({ project, onChanged, notify }: ProjectOnboardingProps) {
  const intake = project.intake;
  const [objective, setObjective] = useState(project.brief?.content?.objective || '');
  const [acceptance, setAcceptance] = useState((project.brief?.content?.acceptance || []).join('\n'));
  const [mode, setMode] = useState<'brainstorm' | 'existing'>(intake?.mode || 'brainstorm');
  const [sourceKind, setSourceKind] = useState<'fixture' | 'local' | 'git'>('fixture');
  const [sourceValue, setSourceValue] = useState('designsignal-v1');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ code: string; message: string; details?: Record<string, unknown> } | null>(null);
  const [confirmName, setConfirmName] = useState('');

  useEffect(() => {
    setObjective(project.brief?.content?.objective || '');
    setAcceptance((project.brief?.content?.acceptance || []).join('\n'));
    setMode(project.intake?.mode || 'brainstorm');
  }, [project.brief?.revision, project.intake?.id, project.intake?.mode]);

  const briefRevision = project.brief?.revision || 0;
  const confirmedRevision = project.confirmed_brief_revision || project.brief_head?.confirmed_revision || null;
  const canBusiness = project.status === 'active' && project.onboarding_state === 'confirmed' && intake?.status === 'ready' && Boolean(confirmedRevision);
  const statusLabel = project.status === 'draft' ? (intake?.status || project.onboarding_state || 'draft') : project.status;
  const operationBusy = busy.startsWith('operation:');
  const setFailure = (cause: unknown) => {
    if (cause instanceof ApiError) setError({ code: cause.code, message: cause.message });
    else if (cause instanceof TypeError) setError({ code: 'offline', message: 'Workspace service is offline' });
    else setError({ code: 'request_failed', message: cause instanceof Error ? cause.message : 'Request failed' });
  };
  const waitOperation = async (operationId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const operation = await api<Operation>(`/api/v1/operations/${operationId}`);
      if (['completed', 'failed', 'cancelled'].includes(operation.status)) {
        if (operation.status !== 'completed') throw new ApiError(409, { error: { code: operation.error_code || operation.status, message: operation.error_code || operation.status, retryable: operation.status === 'failed', request_id: '', details: {} } });
        return operation;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('operation_timeout');
  };
  const runOperation = async (label: string, action: () => Promise<Operation>) => {
    setBusy(`operation:${label}`); setError(null);
    try { const operation = await action(); await waitOperation(operation.operation_id); await onChanged(); notify(`${label} completed`); }
    catch (cause) { setFailure(cause); notify(cause instanceof Error ? cause.message : `${label} failed`, 'error'); }
    finally { setBusy(''); }
  };
  const startIntake = () => runOperation('Intake', () => {
    const source = mode === 'existing'
      ? sourceKind === 'fixture' ? { kind: sourceKind, id: sourceValue.trim() } : sourceKind === 'local' ? { kind: sourceKind, path: sourceValue.trim() } : { kind: sourceKind, url: sourceValue.trim() }
      : undefined;
    return mutate<Operation>(`/api/v1/projects/${project.id}/intakes`, { mode, source, expected_revision: project.revision });
  });
  const cancelIntake = async () => {
    setBusy('cancel'); setError(null);
    try { await mutate(`/api/v1/intakes/${intake?.id}/cancel`, { expected_revision: intake?.revision }); await onChanged(); notify('Intake cancelled'); }
    catch (cause) { setFailure(cause); notify(cause instanceof Error ? cause.message : 'Cancel failed', 'error'); }
    finally { setBusy(''); }
  };
  const retryIntake = () => runOperation('Retry', async () => mutate<Operation>(`/api/v1/intakes/${intake?.id}/retry`, {}));
  const resumeIntake = () => runOperation('Resume', async () => mutate<Operation>(`/api/v1/intakes/${intake?.id}/resume`, {}));
  const createBrief = async () => {
    setBusy('brief'); setError(null);
    try { await mutate(`/api/v1/projects/${project.id}/briefs`, { content: { objective: objective.trim(), acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean), constraints: [] } }); await onChanged(); notify('Brief preview created'); }
    catch (cause) { setFailure(cause); notify(cause instanceof Error ? cause.message : 'Brief preview failed', 'error'); }
    finally { setBusy(''); }
  };
  const confirmBrief = async () => {
    setBusy('confirm'); setError(null);
    try {
      const current = await api<Project>(`/api/v1/projects/${project.id}`);
      await mutate(`/api/v1/projects/${project.id}/briefs/${briefRevision}/confirm`, { expected_revision: current.revision, intake_revision: current.intake?.revision });
      await onChanged(); notify('Brief confirmed');
    } catch (cause) { setFailure(cause); notify(cause instanceof Error ? cause.message : 'Brief confirmation failed', 'error'); }
    finally { setBusy(''); }
  };
  const lifecycle = (action: 'archive' | 'trash' | 'restore' | 'purge') => runOperation(action, async () => {
    const current = await api<Project>(`/api/v1/projects/${project.id}`);
    const body: Record<string, unknown> = { expected_revision: current.revision };
    if (action === 'purge') body.confirm_name = confirmName;
    return mutate<Operation>(`/api/v1/projects/${project.id}/${action}`, body);
  });
  const blockerText = useMemo(() => {
    if (canBusiness) return 'Ready';
    if (project.status !== 'active') return 'Onboarding required';
    if (intake?.status !== 'ready') return 'Intake pending';
    if (!confirmedRevision) return 'Brief confirmation required';
    return 'Revision check required';
  }, [canBusiness, confirmedRevision, intake?.status, project.status]);

  return <section className="project-onboarding panel" aria-label="Project onboarding">
    <div className="project-onboarding-head">
      <div><p className="eyebrow">Project lifecycle</p><h2>{project.name}</h2><span className="project-id mono">{project.id}</span></div>
      <div className="project-status-stack"><span className={`status ${canBusiness ? 'positive' : project.status === 'trashed' ? 'negative' : 'working'}`}><span />{statusLabel.replaceAll('_', ' ')}</span><small>{blockerText}</small></div>
    </div>
    {error && <div className="project-error" role="alert"><CircleAlert size={16} /><div><strong>{error.code}</strong><span>{error.message}</span></div><button className="icon-button" aria-label="Dismiss error" title="Dismiss error" onClick={() => setError(null)}>×</button></div>}
    <div className="onboarding-grid">
      <div className="onboarding-column">
        <div className="subsection-heading"><span>Intake</span><small>Revision {intake?.revision || 0} · Attempt {intake?.attempt || 0}</small></div>
        <div className="segmented" role="group" aria-label="Intake mode"><button className={mode === 'brainstorm' ? 'active' : ''} onClick={() => setMode('brainstorm')} disabled={project.status !== 'draft' || operationBusy}>Brainstorm</button><button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')} disabled={project.status !== 'draft' || operationBusy}>Existing source</button></div>
        {mode === 'existing' && <div className="source-controls"><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)} aria-label="Source kind"><option value="fixture">Fixture</option><option value="local">Local path</option><option value="git">HTTPS Git</option></select><input value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} aria-label="Source locator" placeholder="designsignal-v1" /></div>}
        <div className="intake-actions">
          {['draft', 'failed', 'cancelled'].includes(intake?.status || '') && <button className="button primary" disabled={Boolean(busy)} onClick={() => void (intake?.status === 'failed' ? retryIntake() : intake?.status === 'cancelled' ? resumeIntake() : startIntake())}>{intake?.status === 'failed' ? <RefreshCw size={15} /> : intake?.status === 'cancelled' ? <Play size={15} /> : <Play size={15} />}{intake?.status === 'failed' ? 'Retry intake' : intake?.status === 'cancelled' ? 'Resume intake' : 'Run intake'}</button>}
          {intake?.status === 'running' && <button className="button" disabled={Boolean(busy)} onClick={() => void cancelIntake()}><Square size={15} />Cancel</button>}
          {intake?.status === 'ready' && <span className="inline-success"><Check size={15} />Ready {formatTime(intake.completed_at || undefined)}</span>}
        </div>
        {intake?.status === 'failed' && <div className="fault-line"><CircleAlert size={14} /><span>{intake.error_code || 'intake_failed'}</span></div>}
        {intake?.status === 'cancelled' && <div className="fault-line"><RotateCcw size={14} /><span>Cancelled at revision {intake.revision}</span></div>}
      </div>
      <div className="onboarding-column brief-column">
        <div className="subsection-heading"><span>Brief preview</span><small>Revision {briefRevision} · Confirmed {confirmedRevision || '—'}</small></div>
        <label><span>Objective</span><textarea rows={2} value={objective} onChange={(event) => setObjective(event.target.value)} disabled={project.status === 'purged'} placeholder="A measurable project objective" /></label>
        <label><span>Acceptance</span><textarea rows={2} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} disabled={project.status === 'purged'} placeholder="One criterion per line" /></label>
        <div className="brief-actions"><button className="button" disabled={Boolean(busy) || !objective.trim() || project.status === 'purged'} onClick={() => void createBrief()}><RefreshCw size={15} />Save preview</button><button className="button primary" disabled={Boolean(busy) || !briefRevision || intake?.status !== 'ready' || Boolean(confirmedRevision && confirmedRevision === briefRevision)} onClick={() => void confirmBrief()}><Check size={15} />Confirm revision</button></div>
      </div>
    </div>
    <div className="lifecycle-row"><div><small>Project revision {project.revision}</small><span className="mono">Brief {shortHash(project.confirmed_brief_hash || '')}</span></div><div className="lifecycle-actions">
      {project.status === 'active' && <button className="icon-button" title="Archive project" aria-label="Archive project" disabled={Boolean(busy) || !canBusiness} onClick={() => void lifecycle('archive')}><Archive size={16} /></button>}
      {['active', 'archived'].includes(project.status) && <button className="icon-button" title="Move project to trash" aria-label="Move project to trash" disabled={Boolean(busy) || (project.status === 'active' && !canBusiness)} onClick={() => void lifecycle('trash')}><Trash2 size={16} /></button>}
      {project.status === 'trashed' && <button className="icon-button" title="Restore project" aria-label="Restore project" disabled={Boolean(busy)} onClick={() => void lifecycle('restore')}><Undo2 size={16} /></button>}
      {project.status === 'trashed' && <><input className="purge-confirm" aria-label="Project name confirmation" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder="Type project name" /><button className="icon-button danger" title="Purge project" aria-label="Purge project" disabled={Boolean(busy) || confirmName !== project.name} onClick={() => void lifecycle('purge')}><Trash2 size={16} /></button></>}
    </div></div>
  </section>;
}
