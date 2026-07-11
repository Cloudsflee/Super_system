import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireSetup } from './setup-guard';
import { AppShell } from '../components/shell/AppShell';
import { SetupPage } from '../features/setup/SetupPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { ProjectOnboardingPage } from '../features/projects/onboarding/ProjectOnboardingPage';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { NodeWorkspacePage } from '../features/nodes/NodeWorkspacePage';
import { AssetsPage } from '../features/assets/AssetsPage';
import { AuditPage } from '../features/audit/AuditPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { WorkspaceEntry } from './WorkspaceEntry';

export const router = createBrowserRouter([
  { path: '/setup', element: <SetupPage /> },
  { path: '/integrations/github/install/setup', element: <SetupPage /> },
  {
    element: <RequireSetup />,
    children: [{
      element: <AppShell />,
      children: [
        { index: true, element: <WorkspaceEntry /> },
        { path: '/projects', element: <ProjectsPage /> },
        { path: '/projects/:projectId/onboarding', element: <ProjectOnboardingPage /> },
        { path: '/projects/:projectId/workflow', element: <WorkflowPage /> },
        { path: '/projects/:projectId/nodes/:nodeId', element: <NodeWorkspacePage /> },
        { path: '/assets', element: <AssetsPage /> },
        { path: '/audit', element: <AuditPage /> },
        { path: '/settings', element: <SettingsPage /> }
      ]
    }]
  },
  { path: '*', element: <Navigate to="/projects" replace /> }
]);
