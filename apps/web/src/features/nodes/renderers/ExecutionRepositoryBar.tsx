import { AlertTriangle, ExternalLink, File, GitBranch, Layers3, RefreshCw } from 'lucide-react';

import type { RepositoryBranchCatalog, RepositoryConnection, RepositoryWorkspace } from '../../../api/types';
import { pullRequestStatusLabel } from '../../../components/common/display-labels';

type RepositoryBarProps = {
  connections: RepositoryConnection[];
  catalog?: RepositoryBranchCatalog;
  workspaces: RepositoryWorkspace[];
  connectionId: string;
  branchRef: string;
  workspaceId: string;
  selected: RepositoryWorkspace | null;
  opening: boolean;
  onConnection: (value: string) => void;
  onBranch: (value: string) => void;
  onWorkspace: (value: string) => void;
  onRefresh: () => void;
};

export function RepositoryBar(props: RepositoryBarProps) {
  const branchCopies = props.workspaces.filter((item) => item.ref === props.branchRef);
  return (
    <header className="repository-workspace-bar">
      <RepositorySelectors props={props} />
      {branchCopies.length > 1 && <WorkspaceCopyPicker props={props} workspaces={branchCopies} />}
      <WorkspaceMetadata opening={props.opening} selected={props.selected} />
    </header>
  );
}

function RepositorySelectors({ props }: { props: RepositoryBarProps }) {
  return (
    <>
      <label>
        代码仓库
        <select
          aria-label="代码仓库"
          value={props.connectionId}
          onChange={(event) => props.onConnection(event.target.value)}
        >
          {!props.connections.length && <option value="">默认代码仓库</option>}
          {props.connections.map((item) => (
            <option value={item.id} key={item.id}>
              {item.full_name || item.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        分支
        <select aria-label="分支" value={props.branchRef} onChange={(event) => props.onBranch(event.target.value)}>
          {props.catalog?.branches.map((item) => (
            <option value={item.ref} key={item.full_ref}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button className="row-icon repository-refresh" aria-label="刷新当前分支" onClick={props.onRefresh}>
        <RefreshCw size={15} />
      </button>
    </>
  );
}

function WorkspaceCopyPicker({ props, workspaces }: { props: RepositoryBarProps; workspaces: RepositoryWorkspace[] }) {
  return (
    <details className="repository-workspace-copies">
      <summary aria-label="选择执行副本">
        <Layers3 size={14} />
        <span>执行副本</span>
      </summary>
      <div>
        <label>
          执行副本
          <select
            aria-label="执行副本"
            value={props.workspaceId}
            onChange={(event) => props.onWorkspace(event.target.value)}
          >
            {workspaces.map((item) => (
              <option value={item.id} key={item.id}>
                {shortSha(item.fixed_sha)} · {item.mode === 'read_write' ? '可写' : '只读'}
                {item.stale ? ' · 已过期' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  );
}

function WorkspaceMetadata({ opening, selected }: { opening: boolean; selected: RepositoryWorkspace | null }) {
  if (opening)
    return (
      <div className="repository-workspace-meta" role="status">
        正在准备当前分支
      </div>
    );
  if (!selected) return null;
  return (
    <div className="repository-workspace-meta">
      <code>{shortSha(selected.current_sha)}</code>
      <span>{selected.mode === 'read_write' ? '可写' : '只读'}</span>
      <span>
        <GitBranch size={12} />
        领先 {selected.ahead}/落后 {selected.behind}
      </span>
      {selected.stale && (
        <span className="workspace-warning">
          <AlertTriangle size={12} />
          已过期
        </span>
      )}
      {selected.dirty && <span className="workspace-warning">有未提交变更</span>}
      {selected.pull_requests?.map((item) =>
        item.url ? (
          <a key={item.intent_id} href={item.url} target="_blank" rel="noreferrer">
            合并请求 #{item.number}
            <ExternalLink size={11} />
          </a>
        ) : (
          <span key={item.intent_id}>合并请求 {pullRequestStatusLabel(item.state)}</span>
        )
      )}
    </div>
  );
}

export function FileCapabilityState({
  children,
  detail,
  error = false,
  retry
}: {
  children: string;
  detail?: string;
  error?: boolean;
  retry?: () => unknown;
}) {
  return (
    <div className={`file-capability-state${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
      <File size={18} />
      <strong>{children}</strong>
      {detail && <small>{detail}</small>}
      {retry && (
        <button className="row-icon" aria-label="重新加载文件" onClick={retry}>
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}

export function shortSha(value?: string | null) {
  return String(value || '').slice(0, 8) || '--------';
}
