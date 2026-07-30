import { Activity, Clock3, Database, History, RefreshCw, ServerCog, TriangleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../api/client';
import type { ContextStatusResponse } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import { ToolbarMenu } from '../../components/common/ToolbarMenu';

export function ContextWorkerStatus() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const query = useQuery({
    queryKey: ['context-status'],
    queryFn: () => api<ContextStatusResponse>('/context/v1/status'),
    refetchInterval: 2_000,
    retry: false
  });
  if (query.isError && !query.data) return null;
  const status = query.data;
  const unhealthy = Boolean(status && (status.failed_jobs > 0 || status.worker.last_error_code));
  return (
    <div className="context-worker-status">
      <IconButton
        ref={triggerRef}
        label="Context worker 状态"
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {unhealthy ? <TriangleAlert size={16} /> : <Activity size={16} />}
      </IconButton>
      <ToolbarMenu
        open={open}
        label="Context worker 状态"
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
        className="context-worker-menu"
      >
        <StatusRow icon={<ServerCog size={14} />} label="Worker" value={status?.worker.state || 'starting'} />
        <StatusRow
          icon={<Activity size={14} />}
          label="Heartbeat"
          value={status?.worker.heartbeat_at ? relativeTime(status.worker.heartbeat_at) : '-'}
        />
        <StatusRow
          icon={<Clock3 size={14} />}
          label="Oldest job"
          value={formatDuration(status?.oldest_pending_age_ms || 0)}
        />
        <StatusRow
          icon={<Database size={14} />}
          label="Lease / Failed"
          value={`${status?.active_leases || 0} / ${status?.failed_jobs || 0}`}
        />
        <StatusRow
          icon={<RefreshCw size={14} />}
          label="Index rebuild"
          value={`${status?.automatic_rebuild || 'idle'} · #${status?.index_generation || 0}`}
        />
        <StatusRow
          icon={<History size={14} />}
          label="Lease recovery"
          value={String(status?.worker.recovered_expired_leases || 0)}
        />
        <StatusRow
          icon={<Activity size={14} />}
          label="Event loop lag"
          value={`${Math.round(status?.worker.event_loop_lag_ms || 0)} ms`}
        />
      </ToolbarMenu>
    </div>
  );
}

function StatusRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="context-worker-row" role="menuitem" tabIndex={-1}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function relativeTime(value: string) {
  const age = Math.max(0, Date.now() - Date.parse(value));
  return `${formatDuration(age)} ago`;
}

function formatDuration(value: number) {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)} s`;
  return `${Math.round(value / 60_000)} min`;
}
