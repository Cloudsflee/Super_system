import { Ban, CircleDot, PlayCircle } from 'lucide-react';
import type { NodeWorkspace } from '../../../api/types';
import { api, json } from '../../../api/client';
import { displayStatus, traceEventLabel } from '../../../components/common/display-labels';
import { useUi } from '../../../state/ui';

export function ActivityPanel({ value, onSaved }: { value: NodeWorkspace; onSaved: () => Promise<unknown> }) {
  const toast = useUi((state) => state.toast);
  async function cancel(id: string) {
    try {
      await api(`/runs/${id}/cancel`, json('POST', undefined, '停止节点运行'));
      await onSaved();
      toast('节点运行已停止');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  return (
    <div className="activity-panel">
      <section>
        <header>
          <PlayCircle size={17} />
          <h2>运行</h2>
        </header>
        {value.runs.map((run) => (
          <article key={run.id}>
            <div>
              <strong>{run.id}</strong>
              <span className={`status ${run.status}`}>{displayStatus(run.status)}</span>
            </div>
            <p>{run.summary || '暂无摘要'}</p>
            <footer>
              <time>{new Date(run.created_at).toLocaleString()}</time>
              {['queued', 'running'].includes(run.status) && (
                <button className="button danger" onClick={() => cancel(run.id)}>
                  <Ban size={13} />
                  停止
                </button>
              )}
            </footer>
          </article>
        ))}
        {!value.runs.length && (
          <div className="quiet-empty">
            <PlayCircle size={22} />
            <p>尚无运行</p>
          </div>
        )}
      </section>
      <section>
        <header>
          <CircleDot size={17} />
          <h2>执行轨迹</h2>
        </header>
        <div className="trace-list">
          {value.traces.map((trace) => (
            <div key={trace.id}>
              <i />
              <span>
                <strong>{traceEventLabel(trace.event_type)}</strong>
                <small>{trace.summary}</small>
              </span>
              <time>{new Date(trace.created_at || trace.occurred_at || 0).toLocaleTimeString()}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
