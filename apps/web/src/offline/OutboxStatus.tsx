import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff, ListRestart, RefreshCw, Trash2, X } from 'lucide-react';
import { OfflineOutbox, type OfflineResponse } from './outbox';
import type { OutboxRecord } from './db';
import { commandLabel, statusLabel } from '../i18n';

export function OutboxStatus({ actorId, teamId, projectId }: { actorId: string; teamId: string; projectId: string }) {
  const [rows, setRows] = useState<OutboxRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const outbox = useMemo(() => new OfflineOutbox({ actorId, teamId, projectId }), [actorId, projectId, teamId]);
  const load = useCallback(() => { void outbox.list().then(setRows); }, [outbox]);

  useEffect(() => {
    load();
    window.addEventListener('aiws:outbox-change', load);
    return () => window.removeEventListener('aiws:outbox-change', load);
  }, [load]);

  const pending = rows.filter((row) => ['queued', 'sending'].includes(row.state)).length;
  const blocked = rows.filter((row) => row.state === 'blocked').length;
  const flush = async () => {
    setSending(true);
    try { await outbox.flush(sendRecord, { concurrency: 3 }); await outbox.list().then(setRows); }
    finally { setSending(false); }
  };
  const rebase = async (row: OutboxRecord) => {
    await outbox.rebase(row.key, { expectedRevision: Number(row.server_revision ?? row.expected_revision ?? 0), body: JSON.parse(row.canonical_body) });
    load();
  };
  const discard = async (row: OutboxRecord) => { await outbox.discard(row.aggregate_key); load(); };

  if (!projectId) return null;
  return <div className="outbox-control">
    <button className={`topbar-outbox ${blocked ? 'blocked' : ''}`} aria-label={`离线队列：${pending} 项待发送，${blocked} 项已阻塞`} title="离线队列" onClick={() => setOpen((value) => !value)}>
      <CloudOff size={16} /><span>{pending + blocked}</span>
    </button>
    {open && <div className="outbox-popover" role="dialog" aria-label="离线队列">
      <div className="outbox-head"><strong>离线队列</strong><button className="icon-button" aria-label="关闭离线队列" title="关闭" onClick={() => setOpen(false)}><X size={15} /></button></div>
      <div className="outbox-list">{rows.filter((row) => !['succeeded', 'discarded', 'superseded'].includes(row.state)).map((row) => <div className="outbox-row" key={row.key}>
        <span><strong>{commandLabel(row.command)}</strong><small>{statusLabel(row.state)}{row.state === 'blocked' ? ` · r${row.expected_revision ?? 0} -> r${row.server_revision ?? 0}` : ''}</small></span>
        {row.state === 'blocked' && <button className="icon-button" aria-label={`变基 ${commandLabel(row.command)}`} title="变基" onClick={() => void rebase(row)}><ListRestart size={14} /></button>}
        {['queued', 'blocked'].includes(row.state) && <button className="icon-button" aria-label={`丢弃 ${commandLabel(row.command)}`} title="丢弃" onClick={() => void discard(row)}><Trash2 size={14} /></button>}
      </div>)}{!pending && !blocked && <div className="list-empty">队列为空</div>}</div>
      <button className="button" disabled={sending || !pending || !navigator.onLine} onClick={() => void flush()}>{sending ? <RefreshCw className="spin" size={14} /> : <RefreshCw size={14} />}发送</button>
    </div>}
  </div>;
}

async function sendRecord(record: OutboxRecord): Promise<OfflineResponse> {
  try {
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'Idempotency-Key': record.idempotency_key };
    if (record.expected_revision != null) headers['X-Expected-Revision'] = String(record.expected_revision);
    let response = await fetch(record.path, { method: record.method, credentials: 'same-origin', headers, body: record.canonical_body });
    if (response.status === 401) {
      try {
        const { recoverBrowserSession } = await import('../api');
        await recoverBrowserSession();
        response = await fetch(record.path, { method: record.method, credentials: 'same-origin', headers, body: record.canonical_body });
      } catch { /* retain the original status so the record remains diagnosable */ }
    }
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch { throw new TypeError('network_error'); }
}
