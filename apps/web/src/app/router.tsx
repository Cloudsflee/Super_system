import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireSetup } from './setup-guard';
import { AppShell } from '../components/shell/AppShell';
import { RouteErrorState } from '../components/common/RouteErrorState';
import { WorkspaceEntry } from './WorkspaceEntry';

export const router = createBrowserRouter([
  { path: '/setup', errorElement: <RouteErrorState />, lazy: page(() => import('../features/setup/SetupPage'), 'SetupPage') },
  { path: '/integrations/github/install/setup', errorElement: <RouteErrorState />, lazy: page(() => import('../features/setup/SetupPage'), 'SetupPage') },
  {
    element: <RequireSetup />,
    errorElement: <RouteErrorState />,
    children: [{
      element: <AppShell />,
      errorElement: <RouteErrorState />,
      children: [
        { index: true, element: <WorkspaceEntry /> },
        { path: '/projects', lazy: page(() => import('../features/projects/ProjectsPage'), 'ProjectsPage') },
        { path: '/projects/:projectId/onboarding', lazy: page(() => import('../features/projects/onboarding/ProjectOnboardingPage'), 'ProjectOnboardingPage') },
        { path: '/projects/:projectId/workflow', lazy: page(() => import('../features/workflow/WorkflowPage'), 'WorkflowPage') },
        { path: '/projects/:projectId/workflow/:workstreamId', lazy: page(() => import('../features/workflow/WorkstreamPage'), 'WorkstreamPage') },
        { path: '/projects/:projectId/nodes/:nodeId', lazy: page(() => import('../features/nodes/NodeWorkspacePage'), 'NodeWorkspacePage') },
        { path: '/assets', lazy: page(() => import('../features/assets/AssetsPage'), 'AssetsPage') },
        { path: '/audit', lazy: page(() => import('../features/audit/AuditPage'), 'AuditPage') },
        { path: '/settings', lazy: page(() => import('../features/settings/SettingsPage'), 'SettingsPage') }
      ]
    }]
  },
  { path: '*', element: <Navigate to="/projects" replace /> }
]);

function page<T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) {
  return async () => { const module = await load(); return { Component: module[name] as React.ComponentType }; };
}
