import type { Project } from './types';

export type WorkspaceRoute = 'setup' | 'identity' | 'projects' | 'workflow' | 'context' | 'assist' | 'execution' | 'evidence' | 'operations' | 'files' | 'terminals' | 'approvals' | 'connections' | 'settings';

export interface WorkspacePageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: WorkspaceRoute) => void;
  setupReady: boolean;
  refreshSetup: () => Promise<void>;
}
