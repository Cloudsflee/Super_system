import type { Project } from './types';

export type WorkspaceRoute = 'setup' | 'identity' | 'projects' | 'onboarding' | 'brief' | 'repository' | 'workflow' | 'context' | 'assist' | 'execution' | 'evidence' | 'outcome' | 'delivery' | 'operations' | 'files' | 'terminals' | 'approvals' | 'connections' | 'exchange' | 'gateway' | 'runner' | 'parser' | 'deployment' | 'backup' | 'importer' | 'settings' | 'governance';

export type AssistPageContext = {
  route: WorkspaceRoute;
  projectId: string | null;
  resourceType?: string;
  resourceId?: string;
  revision?: number | null;
  contentHash?: string | null;
  label?: string;
};

export type TerminalLaunchContext = {
  workspaceId?: string;
  runtime?: import('./types').TerminalRuntime;
  cwd?: string;
  command?: string;
  assistSessionId?: string;
  approvalId?: string;
};

export interface WorkspacePageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: WorkspaceRoute) => void;
  navigateProject?: (projectId: string, page: WorkspaceRoute) => void;
  setupReady: boolean;
  refreshSetup: () => Promise<void>;
  assistContext?: AssistPageContext;
  registerAssistContext?: (context: AssistPageContext | undefined) => void;
  openAssist?: (context?: AssistPageContext, attach?: boolean) => void;
  assistAttachRequest?: number;
  openTerminal?: (context?: TerminalLaunchContext) => void;
  terminalLaunch?: TerminalLaunchContext;
  online?: boolean;
}
