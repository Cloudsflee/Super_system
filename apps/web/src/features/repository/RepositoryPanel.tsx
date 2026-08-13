import { useState } from 'react';
import { CircleAlert, GitBranch, LoaderCircle, Radio, RefreshCw, ShieldCheck } from 'lucide-react';
import { ApiError, api, mutate, shortHash } from '../../api';
import type { Project, RepositoryLine } from '../../types';

export interface RepositoryPanelProps {
  project: Project;
  onChanged: () => Promise<void>;
  notify: (message: string, tone?: 'ok' | 'error') => void;
}

type Operation = { operation_id: string; status: string; error_code?: string | null };

export function RepositoryPanel({ project, onChanged, notify }: RepositoryPanelProps) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const lines = project.repository_lines || [];
  const connections = project.repository_connections || [];
  const checkout = lines.find((line) => line.line_kind === 'managed_checkout');
  const wait = async (operationId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const operation = await api<Operation>(`/api/v1/operations/${operationId}`);
      if (['completed', 'failed', 'cancelled'].includes(operation.status)) {
        if (operation.status !== 'completed') throw new ApiError(409, { error: { code: operation.error_code || operation.status, message: operation.error_code || operation.status, retryable: operation.status === 'failed', request_id: '', details: {} } });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('operation_timeout');
  };
  const action = async (kind: 'probe' | 'recover') => {
    if (!checkout) return;
    setBusy(kind); setError('');
    try {
      const operation = await mutate<Operation>(`/api/v1/repository-lines/${checkout.id}/${kind}`, { expected_revision: checkout.revision });
      await wait(operation.operation_id);
      await onChanged();
      notify(`Repository ${kind} completed`);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : cause instanceof Error ? cause.message : 'repository_action_failed';
      setError(code); notify(code, 'error');
    } finally { setBusy(''); }
  };
  return <section className="repository-panel panel" aria-label="Repository">
    <div className="section-title"><div><h2>Repository</h2><span>Connection · Target · Line</span></div><div className="repository-actions">{checkout && checkout.status === 'fault' ? <button className="button" disabled={Boolean(busy)} onClick={() => void action('recover')}><RefreshCw size={15} />Recover</button> : <button className="button" disabled={Boolean(busy) || project.status === 'trashed' || project.status === 'purged'} onClick={() => void action('probe')}><Radio size={15} />Probe</button>}</div></div>
    {error && <div className="fault-line"><CircleAlert size={14} /><span>{error}</span></div>}
    <div className="repository-summary"><div className="repo-summary-icon"><GitBranch size={19} /></div><div><strong>{project.repository?.source?.display_label || 'Managed workspace'}</strong><small>{project.repository?.source?.read_only ? 'Read-only source' : 'Managed source'} · baseline <span className="mono">{shortHash(project.repository?.baseline_sha || project.repository?.head_sha || '')}</span></small></div><ShieldCheck size={17} /></div>
    <div className="repository-table" role="table"><div className="repository-table-head" role="row"><span>Connection</span><span>Target</span><span>Line</span><span>State</span></div>{connections.map((connection) => <div className="repository-table-row" role="row" key={connection.id}><span><strong>{connection.display_label || connection.source_kind || 'source'}</strong><small>{connection.source_kind || 'none'} · r{connection.revision}</small></span><span className="mono">{project.repository?.target_id ? shortHash(project.repository.target_id) : '—'}</span><span className="mono">{project.repository?.line_id ? shortHash(project.repository.line_id) : '—'}</span><span>{connection.fault_code ? <b className="fault-code">{connection.fault_code}</b> : <span className="inline-success"><span />connected</span>}</span></div>)}</div>
    <div className="repository-lines">{lines.map((line) => <LineRow key={line.id} line={line} />)}{!lines.length && <div className="list-empty">No repository lines</div>}</div>
  </section>;
}

function LineRow({ line }: { line: RepositoryLine }) {
  const labels: Record<RepositoryLine['line_kind'], string> = { external_readonly: 'External read-only', managed_staging: 'Managed staging', managed_checkout: 'Managed checkout' };
  const negative = line.status === 'fault' || line.status === 'blocked';
  return <div className="repository-line-row"><span className="line-kind"><GitBranch size={14} /><strong>{labels[line.line_kind]}</strong></span><span className="mono">{shortHash(line.baseline_sha || line.head_sha || '')}</span><span className={`status ${negative ? 'negative' : line.status === 'ready' ? 'positive' : 'working'}`}><span />{line.status}</span>{line.fault_code && <b className="fault-code">{line.fault_code}</b>}{line.locked && <span className="line-lock"><LoaderCircle size={12} className="spin" />locked</span>}</div>;
}
