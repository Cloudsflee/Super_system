import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { ContextMenuProvider } from './components/common/ContextMenu';
import { OperationFeedbackProvider } from './operations/OperationFeedback';
import './styles/global.css';
import './styles/shell.css';
import './styles/approvals.css';
import './styles/assist-workbench.css';
import './styles/assist-timeline.css';
import './styles/assist-composer.css';
import './styles/assist-review.css';
import './styles/assist-interactions.css';
import './styles/assist-focus-responsive.css';
import '@xterm/xterm/css/xterm.css';
import './styles/setup.css';
import './styles/projects.css';
import './styles/onboarding.css';
import './styles/workflow-canvas.css';
import './styles/workflow-workstream.css';
import './styles/workflow-migration.css';
import './styles/workflow-toolbar.css';
import './styles/workflow-process-structure.css';
import './styles/workflow-process-replan.css';
import './styles/workflow-process-tasks.css';
import './styles/workflow-process-bands.css';
import './styles/workflow-process-details.css';
import './styles/workflow-process-responsive.css';
import './styles/workspace.css';
import './styles/data.css';
import './styles/overlays.css';
import './styles/operations.css';
import './styles/theme.css';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <OperationFeedbackProvider>
        <ContextMenuProvider>
          <RouterProvider router={router} />
        </ContextMenuProvider>
      </OperationFeedbackProvider>
    </QueryClientProvider>
  </StrictMode>
);
