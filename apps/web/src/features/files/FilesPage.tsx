import { useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import type { WorkspacePageProps } from '../../workspace';
import { FilesDrawer } from './FilesDrawer';

export function FilesPage({ projectId, notify, navigate }: WorkspacePageProps) {
  const [open, setOpen] = useState(true);
  if (!projectId) {
    return <div className="empty-state"><FileText size={28} /><h2>请选择项目以打开文件</h2><button className="button" onClick={() => navigate('projects')}>项目</button></div>;
  }
  return <div className="page files-page">
    <div className="page-heading"><div><p className="eyebrow">托管工作区</p><h1>文件</h1></div></div>
    <div className="empty-state files-route-empty"><FolderOpen size={28} /><h2>文件抽屉已关闭</h2><button className="button" onClick={() => setOpen(true)}><FolderOpen size={15} />打开文件</button></div>
    <FilesDrawer open={open} projectId={projectId} notify={notify} onClose={() => { setOpen(false); navigate('assist'); }} />
  </div>;
}
