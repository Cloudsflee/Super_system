import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import type { AssistScopeBreadcrumbItem, AssistScopeType, Project } from '../../api/types';
import { useUi } from '../../state/ui';
import { AssistControllerProvider } from './AssistContext';
import { CommandDock } from './CommandDock';
import { useAssistController } from './useAssistController';

const AssistWorkbench = lazy(() => import('./AssistWorkbench').then((module) => ({ default: module.AssistWorkbench })));

export function AssistCenter({
  project,
  scopeType,
  scopeId,
  scopeBreadcrumb,
  commandDock
}: {
  project?: Project;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  commandDock: boolean;
}) {
  return (
    <AssistCenterScope
      key={`${project?.id || 'no-project'}:${scopeType || ''}:${scopeId || ''}`}
      project={project}
      scopeType={scopeType}
      scopeId={scopeId}
      scopeBreadcrumb={scopeBreadcrumb}
      commandDock={commandDock}
    />
  );
}

function AssistCenterScope({
  project,
  scopeType,
  scopeId,
  scopeBreadcrumb,
  commandDock
}: {
  project?: Project;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  commandDock: boolean;
}) {
  const location = useLocation();
  const assistOpen = useUi((state) => state.assistOpen);
  const controller = useAssistController({
    projectId: project?.id,
    scopeType,
    scopeId,
    scopeBreadcrumb,
    enabled: Boolean(project?.id && scopeType && scopeId && (commandDock || assistOpen)),
    route: location.pathname
  });
  return (
    <AssistControllerProvider controller={controller}>
      {commandDock && project && <CommandDock project={project} />}
      <Suspense fallback={null}>
        <AssistWorkbench project={project} />
      </Suspense>
    </AssistControllerProvider>
  );
}
