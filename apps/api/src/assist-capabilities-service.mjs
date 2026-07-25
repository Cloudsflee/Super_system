import { ASSIST_CAPABILITY_MANIFEST, validateAssistCapabilityManifest } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { exposedControls, pageIdentity } from './assist-operation-utils.mjs';
import { readState } from './state.mjs';
import { currentBrief, currentWorkflow, currentWorkflowDraft, routeProjectId } from './assist-project-tool-context.mjs';
import { workflowAssistSurfaceId, workflowAssistSurfaceRevision } from './workflow-graph-service.mjs';

validateAssistCapabilityManifest();

export async function listAssistCapabilities(query = {}) {
  const state = await readState();
  const session = query.session_id
    ? state.assist_sessions.find((item) => item.id === query.session_id && item.version === 3)
    : null;
  const sessionPage = pageIdentity(session?.view_context);
  const projectId = cleanText(query.project_id || session?.project_id, 200) || null;
  const route = cleanText(query.route || sessionPage.route, 2_000) || null;
  const surfaceId = cleanText(query.surface_id || sessionPage.surfaceId, 200) || null;
  const surfaceRevision = cleanText(query.surface_revision || sessionPage.revision, 200) || null;
  const mode = cleanText(query.collaboration_mode, 20) === 'plan' ? 'plan' : 'default';
  const project = projectId ? state.projects.find((item) => item.id === projectId && !item.deleted_at) : null;
  const routeScope = route ? routeProjectId(route) : null;
  const controls = exposedControls(session?.view_context);
  const brief = project ? currentBrief(state, projectId) : null,
    draft = project ? currentWorkflowDraft(state, projectId) : null,
    workflow = project ? currentWorkflow(state, projectId) : null;
  const current = ASSIST_CAPABILITY_MANIFEST.map((descriptor) => {
    const routeMatches = route ? matchesRoute(descriptor.route, route) : false;
    const requiresProject = descriptor.id.startsWith('project.');
    const surfaceKind =
      descriptor.id === 'surface.field.set'
        ? 'field'
        : descriptor.id === 'surface.filter.set'
          ? 'filter'
          : descriptor.id === 'surface.tab.select'
            ? 'tab'
            : null;
    const projectScopeMatches = !requiresProject || Boolean(project && routeScope === projectId);
    const resourceAvailable =
      !requiresProject ||
      (descriptor.id.startsWith('project.brief.')
        ? Boolean(brief)
        : descriptor.id.startsWith('project.workflow_draft.')
          ? Boolean(draft)
          : Boolean(workflow));
    const workflowSurfaceMatches =
      !descriptor.id.startsWith('project.workflow.') ||
      Boolean(
        workflow &&
        surfaceId === workflowAssistSurfaceId(workflow.id) &&
        surfaceRevision === workflowAssistSurfaceRevision(workflow)
      );
    const surfaceContextMatches =
      !surfaceKind ||
      Boolean(
        session &&
        sessionPage.route === route &&
        sessionPage.surfaceId === surfaceId &&
        sessionPage.revision === surfaceRevision
      );
    const surfaceControlAvailable = !surfaceKind || controls.some((item) => item.kind === surfaceKind);
    const reason = unavailableReason({
      descriptor,
      mode,
      route,
      routeMatches,
      requiresProject,
      projectId,
      projectScopeMatches,
      resourceAvailable,
      workflowSurfaceMatches,
      surfaceId,
      surfaceRevision,
      surfaceKind,
      session,
      surfaceContextMatches,
      surfaceControlAvailable
    });
    const available = reason === null;
    return {
      capability_id: descriptor.id,
      available,
      reason,
      route: descriptor.route,
      project_id: projectId,
      surface_id: surfaceId,
      surface_revision: surfaceRevision
    };
  });
  return {
    schema_version: 'aiws.assist-capabilities.v1',
    descriptors: ASSIST_CAPABILITY_MANIFEST,
    current,
    context: {
      session_id: session?.id || null,
      route,
      project_id: projectId,
      surface_id: surfaceId,
      surface_revision: surfaceRevision,
      collaboration_mode: mode
    }
  };
}

function unavailableReason(context) {
  const {
    descriptor,
    mode,
    route,
    routeMatches,
    requiresProject,
    projectId,
    projectScopeMatches,
    resourceAvailable,
    workflowSurfaceMatches,
    surfaceId,
    surfaceRevision,
    surfaceKind,
    session,
    surfaceContextMatches,
    surfaceControlAvailable
  } = context;
  if (mode === 'plan' && descriptor.mutation) return 'plan_read_only';
  if (!route) return 'route_required';
  if (!routeMatches) return 'different_route';
  if (requiresProject && !projectId) return 'project_scope_required';
  if (!projectScopeMatches) return 'project_scope_mismatch';
  if (!resourceAvailable) return 'resource_unavailable';
  if (!surfaceId) return 'surface_id_required';
  if (!surfaceRevision) return 'surface_revision_required';
  if (!workflowSurfaceMatches) return 'workflow_surface_mismatch';
  if (surfaceKind && !session) return 'session_required';
  if (surfaceKind && !surfaceContextMatches) return 'session_surface_mismatch';
  if (surfaceKind && !surfaceControlAvailable) return 'surface_controls_unavailable';
  return null;
}

function matchesRoute(pattern, route) {
  if (pattern === '/**') return route.startsWith('/');
  const escaped = pattern
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}(?:/)?$`).test(route.split(/[?#]/)[0]);
}
