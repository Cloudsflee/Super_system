import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Check, GitPullRequestDraft, LoaderCircle, Play, RefreshCw, RotateCcw, ServerCog, ShieldAlert, Trash2 } from 'lucide-react';
import { apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Delivery = { id: string; branch_name: string; status: string; target_head_sha: string; revision: number; updated_at?: string };
type Operation = { operation_id: string; command_id: string; status: string; revision: number; error_code?: string; parent_operation_id?: string | null; reconciliation_state?: string };
type ImportBatch = { id: string; status: string; revision: number; target_sha256?: string; conflict_count?: number };
type Candidate = { id: string; status: string; revision: number; app_digest: string; candidate_sha256: string };
type Backup = { id: string; source_user_version: number; manifest_sha256: string; retention_class: string; created_at: string };
type GcPlan = { count: number; plan_sha256: string; candidates: string[] };
type Interaction = { id: string; action?: string; question?: string; status?: string; decision?: string; operation_id?: string; revision: number };

const NON_REPLAYABLE = new Set(['delivery.intent.merge', 'backup.create', 'restore.prepare', 'system.reset.prepare', 'import.cutover', 'cas.gc.apply']);

export function OperationsPage({ projectId, notify }: WorkspacePageProps) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [approvals, setApprovals] = useState<Interaction[]>([]);
  const [inputs, setInputs] = useState<Interaction[]>([]);
  const [health, setHealth] = useState('unknown');
  const [gcPlan, setGcPlan] = useState<GcPlan | null>(null);
  const [targetVolumeRef, setTargetVolumeRef] = useState('isolated-runtime');
  const [preserveBackups, setPreserveBackups] = useState(true);
  const [fault, setFault] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [delivery, operation, batches, deployment, backup, approval, input, ready] = await Promise.all([
        apiV2<{ deliveries: Delivery[] }>(`/api/v2/deliveries?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ operations: Operation[] }>(`/api/v2/operations?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ imports: ImportBatch[] }>('/api/v2/imports'),
        apiV2<{ active: Candidate | null; candidates: Candidate[] }>('/api/v2/system/deployment'),
        apiV2<{ backups: Backup[] }>('/api/v2/backups'),
        apiV2<{ approvals: Interaction[] }>(`/api/v2/approvals?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ inputs: Interaction[] }>(`/api/v2/user-inputs?project_id=${encodeURIComponent(projectId)}`),
        fetch('/readyz', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      ]);
      setDeliveries(delivery.data.deliveries || []);
      setOperations(operation.data.operations || []);
      setImports(batches.data.imports || []);
      setCandidates(deployment.data.candidates || []);
      setBackups(backup.data.backups || []);
      setApprovals(approval.data.approvals || []);
      setInputs(input.data.inputs || []);
      setHealth(ready.ok && String((ready.body as { data?: { status?: string } }).data?.status || '') === 'ready' ? 'ready' : 'failed');
      setFault('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'operations_request_failed';
      setFault(message);
      notify(message, 'error');
    } finally { setLoading(false); }
  }, [notify, projectId]);

  useEffect(() => { void load(); }, [load]);

  const reconcile = async (delivery: Delivery) => run(`delivery:${delivery.id}`, async () => {
    await mutateV2(`/api/v2/deliveries/${encodeURIComponent(delivery.id)}/reconcile`, {}, 'POST', { expectedRevision: delivery.revision });
    notify('Delivery reconciliation completed.');
    await load();
  });

  const replay = async (operation: Operation) => run(`operation:${operation.operation_id}`, async () => {
    await mutateV2(`/api/v2/operations/${encodeURIComponent(operation.operation_id)}/replay`, {}, 'POST', { expectedRevision: operation.revision });
    notify('Operation replay queued.');
    await load();
  });

  const planGc = async () => run('gc', async () => {
    const response = await mutateV2<{ plan: GcPlan }>('/api/v2/cas/gc/plan', { limit: 1000 }, 'POST', { expectedRevision: 0 });
    setGcPlan(response.data.plan);
    notify('CAS GC plan created.');
  });

  const approved = (action: string, requestMatch?: (value: Interaction) => boolean) => approvals.find((item) => item.action === action && (item.decision || item.status) === 'approved' && (!requestMatch || requestMatch(item)));
  const createBackup = async () => run('backup-create', async () => {
    const approval = approved('backup.create');
    if (!approval) throw new Error('An approved backup.create request is required.');
    await mutateV2('/api/v2/backups', { approval_id: approval.id, retention_class: 'standard', components: {} }, 'POST', 0);
    await load();
  });
  const prepareRestore = async (backup: Backup) => run(`restore:${backup.id}`, async () => {
    const approval = approved('restore.prepare', (item) => String((item as Interaction & { request?: { backup_id?: string } }).request?.backup_id || '') === backup.id) || approved('restore.prepare');
    if (!approval) throw new Error('An approved restore.prepare request is required.');
    await mutateV2('/api/v2/restore/prepare', { backup_id: backup.id, approval_id: approval.id, target_volume_ref: targetVolumeRef }, 'POST', 0);
    await load();
  });
  const prepareReset = async () => run('reset', async () => {
    const approval = approved('system.reset.prepare');
    if (!approval) throw new Error('An approved system.reset.prepare request is required.');
    await mutateV2('/api/v2/system/reset/prepare', { approval_id: approval.id, target_volume_ref: targetVolumeRef, preserve_backups: preserveBackups }, 'POST', 0);
    await load();
  });
  const applyGc = async () => run('gc-apply', async () => {
    if (!gcPlan) return;
    const approval = approved('cas.gc.apply');
    if (!approval) throw new Error('An approved cas.gc.apply request is required.');
    await mutateV2('/api/v2/cas/gc/apply', { approval_id: approval.id, plan: gcPlan }, 'POST', 0);
    await load();
  });

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : 'operation_failed'; setFault(message); notify(message, 'error'); }
    finally { setBusy(''); }
  };

  if (!projectId) return <div className="empty-state"><ServerCog size={26} /><h2>No project selected</h2></div>;

  return <div className="page operations-page-p8">
    <div className="page-heading operations-heading-p8">
      <div><p className="eyebrow">Runtime control</p><h1>Operations</h1></div>
      <button className="icon-button" aria-label="Refresh operations" title="Refresh operations" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
    </div>
    {fault && <div className="execution-fault" role="alert"><ShieldAlert size={16} /><span>{fault}</span></div>}
    <div className="operations-summary-p8" aria-label="Operations summary">
      <Metric label="Deliveries" value={deliveries.length} />
      <Metric label="Active" value={operations.filter((item) => ['accepted', 'queued', 'running', 'paused'].includes(item.status)).length} />
      <Metric label="Candidates" value={candidates.length} />
      <Metric label="Backups" value={backups.length} />
      <Metric label="Imports" value={imports.length} />
      <Metric label="Human queue" value={approvals.filter((item) => (item.decision || item.status) === 'pending').length + inputs.filter((item) => item.status === 'pending').length} />
    </div>
    <div className="operations-grid-p8">
      <section aria-labelledby="delivery-heading"><SectionHeading id="delivery-heading" title="Delivery" icon={<GitPullRequestDraft size={18} />} />
        {deliveries.map((item) => <Row key={item.id} title={item.branch_name} detail={item.status === 'needs_reconcile' ? 'External result unknown' : shortHash(item.target_head_sha)} status={item.status} action={item.status === 'needs_reconcile' ? <IconAction label="Reconcile delivery" busy={busy === `delivery:${item.id}`} icon={<RefreshCw size={15} />} onClick={() => void reconcile(item)} /> : null} />)}
        {!loading && !deliveries.length && <p className="list-empty">No deliveries</p>}
      </section>
      <section aria-labelledby="deployment-heading"><SectionHeading id="deployment-heading" title="Deployment" icon={<ServerCog size={18} />} />
        {candidates.map((item) => <Row key={item.id} title={shortHash(item.app_digest)} detail={shortHash(item.candidate_sha256)} status={item.status} />)}
        {!loading && !candidates.length && <p className="list-empty">No candidates</p>}
      </section>
      <section aria-labelledby="backup-heading"><SectionHeading id="backup-heading" title="Backup & Restore" icon={<ArchiveRestore size={18} />} action={<div className="row-actions"><IconAction label="Create backup" busy={busy === 'backup-create'} icon={<ArchiveRestore size={15} />} onClick={() => void createBackup()} /><IconAction label="Prepare reset" busy={busy === 'reset'} icon={<RotateCcw size={15} />} onClick={() => void prepareReset()} /></div>} />
        <div className="operations-recovery-form"><label><span>Target volume reference</span><input value={targetVolumeRef} onChange={(event) => setTargetVolumeRef(event.target.value)} pattern="[A-Za-z][A-Za-z0-9._~-]{0,255}" maxLength={256} /></label><label className="checkbox-line"><input type="checkbox" checked={preserveBackups} onChange={(event) => setPreserveBackups(event.target.checked)} /><span>Preserve backups</span></label></div>
        {backups.map((item) => <Row key={item.id} title={shortHash(item.manifest_sha256)} detail={`schema v${item.source_user_version} · ${item.retention_class}`} status="verified" action={<IconAction label={`Prepare restore ${shortHash(item.id)}`} busy={busy === `restore:${item.id}`} icon={<ArchiveRestore size={15} />} onClick={() => void prepareRestore(item)} />} />)}
        {!loading && !backups.length && <p className="list-empty">No backups</p>}
      </section>
      <section aria-labelledby="operation-heading"><SectionHeading id="operation-heading" title="Operation Lineage" icon={<RotateCcw size={18} />} />
        {operations.map((item) => <Row key={item.operation_id} title={item.command_id} detail={item.error_code || (item.parent_operation_id ? `retry of ${shortHash(item.parent_operation_id)}` : item.reconciliation_state === 'unknown' ? 'External result unknown' : shortHash(item.operation_id))} status={item.status} action={item.status === 'failed' && !NON_REPLAYABLE.has(item.command_id) ? <IconAction label="Replay operation" busy={busy === `operation:${item.operation_id}`} icon={<Play size={15} />} onClick={() => void replay(item)} /> : null} />)}
        {!loading && !operations.length && <p className="list-empty">No operations</p>}
      </section>
      <section aria-labelledby="import-heading"><SectionHeading id="import-heading" title="Imports" />
        {imports.map((item) => <Row key={item.id} title={shortHash(item.target_sha256 || item.id)} detail={item.status === 'blocked' ? `blocked import · ${item.conflict_count || 0} conflicts` : `revision ${item.revision}`} status={item.status} />)}
        {!loading && !imports.length && <p className="list-empty">No imports</p>}
      </section>
      <section aria-labelledby="gc-heading"><SectionHeading id="gc-heading" title="CAS GC" icon={<Trash2 size={18} />} action={<div className="row-actions"><IconAction label="Create GC plan" busy={busy === 'gc'} icon={<Play size={15} />} onClick={() => void planGc()} />{gcPlan && <IconAction label="Apply GC plan" busy={busy === 'gc-apply'} icon={<Check size={15} />} onClick={() => void applyGc()} />}</div>} />
        {gcPlan ? <Row title={shortHash(gcPlan.plan_sha256)} detail={`${gcPlan.count} candidates`} status="planned" /> : <p className="list-empty">No active plan</p>}
      </section>
      <section aria-labelledby="human-heading"><SectionHeading id="human-heading" title="Human queue" icon={<ShieldAlert size={18} />} />
        {approvals.map((item) => <Row key={item.id} title={item.action || 'Approval'} detail={item.operation_id ? `operation ${shortHash(item.operation_id)}` : `revision ${item.revision}`} status={item.decision || item.status || 'pending'} />)}
        {inputs.map((item) => <Row key={item.id} title={item.question || 'Manual input'} detail={item.operation_id ? `operation ${shortHash(item.operation_id)}` : `revision ${item.revision}`} status={item.status || 'pending'} />)}
        {!loading && !approvals.length && !inputs.length && <p className="list-empty">No pending interactions</p>}
      </section>
      <section aria-labelledby="health-heading"><SectionHeading id="health-heading" title="Health" icon={<ServerCog size={18} />} />
        <Row title="V3-Clean" detail={health === 'ready' ? 'schema and dependencies ready' : 'Health check failed'} status={health} />
      </section>
    </div>
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function SectionHeading({ id, title, icon, action }: { id: string; title: string; icon?: React.ReactNode; action?: React.ReactNode }) { return <div className="section-title"><div>{icon}<h2 id={id}>{title}</h2></div>{action}</div>; }
function Row({ title, detail, status, action }: { title: string; detail: string; status: string; action?: React.ReactNode }) { return <div className="operation-row-p8"><span><strong>{title}</strong><small>{detail}</small></span><div className="operation-row-tail-p8"><Status value={status} />{action}</div></div>; }
function IconAction({ label, icon, busy, onClick }: { label: string; icon: React.ReactNode; busy: boolean; onClick: () => void }) { return <button className="icon-button compact-icon-p8" aria-label={label} title={label} disabled={busy} onClick={onClick}>{busy ? <LoaderCircle className="spin" size={15} /> : icon}</button>; }
function Status({ value }: { value: string }) { const tone = ['merged', 'verified', 'passed', 'ready', 'sealed', 'succeeded'].includes(value) ? 'positive' : ['accepted', 'queued', 'running', 'candidate', 'planned', 'verifying'].includes(value) ? 'working' : ['failed', 'blocked', 'needs_reconcile', 'unknown'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>; }
