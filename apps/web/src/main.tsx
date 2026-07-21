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
import './styles/assist-v3.css';
import '@xterm/xterm/css/xterm.css';
import './styles/setup.css';
import './styles/projects.css';
import './styles/onboarding.css';
import './styles/workflow.css';
import './styles/workflow-process.css';
import './styles/workspace.css';
import './styles/data.css';
import './styles/overlays.css';
import './styles/operations.css';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <OperationFeedbackProvider><ContextMenuProvider><RouterProvider router={router} /></ContextMenuProvider></OperationFeedbackProvider>
    </QueryClientProvider>
  </StrictMode>
);
