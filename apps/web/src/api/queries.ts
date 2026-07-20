import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { DeploymentStatus, Project, ProjectBundle, ProjectOnboarding, SetupState, WorkflowMigrationState } from './types';

export const keys = {
  setup: ['setup'] as const,
  deployment: ['deployment'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  onboarding: (id: string) => ['project-onboarding', id] as const,
  workspace: (id: string) => ['node-workspace', id] as const,
  proposals: (projectId?: string) => ['proposals', projectId || 'all'] as const,
  approvals: (projectId?: string) => ['approvals', projectId || 'all'] as const,
  workflowMigrations: ['workflow-migrations'] as const
};

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: () => api<SetupState>('/setup/status'), staleTime: 2_000 });
}

export function useDeployment() {
  return useQuery({ queryKey: keys.deployment, queryFn: () => api<DeploymentStatus>('/system/deployment'), staleTime: 30_000 });
}

export function useProjects(enabled = true) {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>('/projects'), enabled });
}

export function useProject(projectId?: string) {
  return useQuery({
    queryKey: keys.project(projectId || ''),
    queryFn: () => api<ProjectBundle>(`/projects/${projectId}`),
    enabled: Boolean(projectId)
  });
}

export function useProjectOnboarding(projectId?: string) {
  return useQuery({
    queryKey: keys.onboarding(projectId || ''),
    queryFn: () => api<ProjectOnboarding>(`/projects/${projectId}/onboarding`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => query.state.data?.imports.some((item) => ['queued', 'running', 'staging'].includes(item.status)) ? 1_000 : false
  });
}

export function useWorkflowMigrations(enabled = true) {
  return useQuery({
    queryKey: keys.workflowMigrations,
    queryFn: () => api<WorkflowMigrationState>('/workflow-migrations'),
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.batch?.status;
      return status && ['pending_approval', 'approved', 'running', 'waiting_active_runs'].includes(status) ? 1_500 : false;
    }
  });
}
