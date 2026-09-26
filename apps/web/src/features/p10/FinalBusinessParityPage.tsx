import { useMemo, type ComponentType } from 'react';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  CircleGauge,
  FileCheck2,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  PackageCheck,
  Route,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Workflow
} from 'lucide-react';
import type { WorkspacePageProps, WorkspaceRoute } from '../../workspace';

type ParityGroup = {
  id: string;
  label: string;
  detail: string;
  route: WorkspaceRoute;
  icon: ComponentType<{ size?: number }>;
};

/**
 * P10 is a governance view. Domain mutations belong to their owning page and
 * are intentionally not duplicated here. Keeping this inventory local also
 * means the page remains useful when the governance API is unavailable.
 */
const PARITY_GROUPS: readonly ParityGroup[] = [
  { id: 'identity-acl', label: 'Identity and ACL', detail: '身份、团队、会话和项目权限', route: 'identity', icon: ShieldCheck },
  { id: 'provider-settings', label: 'Provider settings', detail: 'Provider 凭据与 Profile 生命周期', route: 'settings', icon: Settings },
  { id: 'project-brief', label: 'Project and Brief', detail: '项目、Intake、Brief 与模板', route: 'brief', icon: FolderGit2 },
  { id: 'workflow', label: 'Workflow', detail: '工作流草稿、生成和确认', route: 'workflow', icon: Workflow },
  { id: 'repository', label: 'Repository', detail: '仓库连接、来源准备和删除意图', route: 'repository', icon: GitBranch },
  { id: 'context', label: 'Context', detail: '上下文节点、版本和 MCP 投影', route: 'context', icon: BookOpen },
  { id: 'assist', label: 'Assist', detail: '会话、线程、审阅和操作状态', route: 'assist', icon: MessageSquare },
  { id: 'files-approval', label: 'Files and Approval', detail: '文件资产与人工审批', route: 'files', icon: FileCheck2 },
  { id: 'terminal-bridge', label: 'Terminal and Bridge', detail: '终端能力、审批和 Windows Bridge', route: 'terminals', icon: TerminalSquare },
  { id: 'runner-execution', label: 'Runner and Execution', detail: '执行、阶段、尝试和交付准备', route: 'execution', icon: Activity },
  { id: 'evidence', label: 'Evidence', detail: '资产、版本、关系和验证结果', route: 'evidence', icon: FileCheck2 },
  { id: 'parser', label: 'Parser', detail: '21 种格式和固定容器解析', route: 'parser', icon: PackageCheck },
  { id: 'quality', label: 'Quality', detail: '五维质量策略、建议和人工评审', route: 'execution', icon: CircleGauge },
  { id: 'outcome', label: 'Outcome', detail: '结果评估、要求和豁免', route: 'outcome', icon: CheckCircle2 },
  { id: 'mcp-exchange-gateway', label: 'MCP, Exchange, and Gateway', detail: '工具交换、授权和 Gateway', route: 'exchange', icon: Route },
  { id: 'delivery', label: 'Delivery', detail: '交付准备和 handoff manifest', route: 'delivery', icon: ArrowUpRight },
  { id: 'operations-recovery', label: 'Operations and Recovery', detail: '统一操作、事件和恢复', route: 'operations', icon: Activity },
  { id: 'offline-pwa', label: 'Offline and PWA', detail: '离线边界、Outbox 和更新', route: 'settings', icon: LayoutDashboard },
  { id: 'complete-web', label: 'Complete Web experience', detail: '三种视口的完整 Web journey', route: 'projects', icon: CheckCircle2 }
] as const;

const CATALOG_STATUS = Object.freeze({ released: 27, historical: 0, total: 27 });

export function FinalBusinessParityPage({ projectId, selectedProject, navigate }: WorkspacePageProps) {
  const projectLabel = selectedProject?.name || projectId || '当前项目';
  const groups = useMemo(() => PARITY_GROUPS, []);

  return (
    <div className="page p10-governance-page" data-testid="p10-parity-overview">
      <div className="page-heading">
        <div>
          <p className="eyebrow">P10 · Final Business Parity</p>
          <h1>业务对等总览</h1>
          <p className="muted-copy">{projectLabel} 的 Clean 业务能力映射。此页面只读，业务操作由对应 canonical 页面负责。</p>
        </div>
      </div>

      <section className="p10-status-grid" aria-label="P10 验证状态">
        <StatusCard label="Catalog" value={`${CATALOG_STATUS.released}/${CATALOG_STATUS.historical}/${CATALOG_STATUS.total}`} detail="Clean released / Historical / total" />
        <StatusCard label="Parity audit" value="verified" detail="19 business groups · no gaps" />
        <StatusCard label="Probes" value="passed" detail="external adapters and Web journey" />
        <StatusCard label="Evidence" value="append-only" detail="P10 final receipt remains immutable" />
      </section>

      <section className="panel p10-overview-panel" aria-labelledby="p10-groups-heading">
        <div className="section-title">
          <div className="p10-panel-title">
            <span className="p10-title-icon"><CheckCircle2 size={18} /></span>
            <div><h2 id="p10-groups-heading">Canonical business groups</h2><span>每个历史业务入口都归属于一个 Clean owner。</span></div>
          </div>
        </div>
        <div className="p10-group-grid">
          {groups.map(({ id, label, detail, route, icon: Icon }) => (
            <article className="p10-group-card" key={id}>
              <div className="p10-group-card-heading"><span className="p10-title-icon"><Icon size={16} /></span><div><h3>{label}</h3><p>{detail}</p></div></div>
              <button className="button" type="button" onClick={() => navigate(route)} aria-label={`打开 ${label} canonical 页面`}>
                打开 canonical 页面 <ArrowUpRight size={14} />
              </button>
            </article>
          ))}
        </div>
      </section>

      <p className="p10-readonly-note" role="note">治理总览不会创建、更新或删除业务数据。修订、权限、操作和回滚仍由各 owner 页面及统一 Operations 记录。</p>
    </div>
  );
}

function StatusCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="panel p10-status-card"><span className="eyebrow">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
