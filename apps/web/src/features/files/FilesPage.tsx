import { useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import type { WorkspacePageProps } from '../../workspace';
import { FilesDrawer } from './FilesDrawer';

export function FilesPage({ projectId, notify, navigate }: WorkspacePageProps) {
  const [open, setOpen] = useState(true);
  if (!projectId) {
    return <div className="empty-state"><FileText size={28} /><h2>Select a project to open Files</h2><button className="button" onClick={() => navigate('projects')}>Projects</button></div>;
  }
  return <div className="page files-page">
    <div className="page-heading"><div><p className="eyebrow">Managed workspace</p><h1>Files</h1></div></div>
    <div className="empty-state files-route-empty"><FolderOpen size={28} /><h2>Files drawer closed</h2><button className="button" onClick={() => setOpen(true)}><FolderOpen size={15} />Open Files</button></div>
    <FilesDrawer open={open} projectId={projectId} notify={notify} onClose={() => { setOpen(false); navigate('assist'); }} />
  </div>;
}
