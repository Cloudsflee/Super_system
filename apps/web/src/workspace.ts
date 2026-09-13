import type { Project } from './types';

export type WorkspaceRoute = 'setup' | 'identity' | 'projects' | 'onboarding' | 'brief' | 'repository' | 'workflow' | 'context' | 'assist' | 'execution' | 'evidence' | 'outcome' | 'delivery' | 'operations' | 'files' | 'terminals' | 'approvals' | 'connections' | 'exchange' | 'gateway' | 'runner' | 'parser' | 'deployment' | 'backup' | 'importer' | 'settings' | 'governance';

export interface WorkspacePageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: WorkspaceRoute) => void;
  navigateProject?: (projectId: string, page: WorkspaceRoute, query?: Record<string, string>) => void;
  setupReady: boolean;
  refreshSetup: () => Promise<void>;
}

export function projectDeepLink(projectId: string, view: WorkspaceRoute = 'workflow', query?: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return `#/projects/${encodeURIComponent(projectId)}/${view}${search ? `?${search}` : ''}`;
}
