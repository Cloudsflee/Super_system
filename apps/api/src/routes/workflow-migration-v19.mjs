import { HttpError, makeRoute, send } from '../http.mjs';
import { accessibleProjectIds, actorForRequest, instanceOwnerId, membershipFor } from '../project-governance-v19.mjs';
import { readState } from '../state.mjs';
import {
  approveWorkflowMigrationBatch, cancelWorkflowMigrationBatch, getWorkflowMigrationState,
  retryWorkflowMigrationJob
} from '../workflow-migration-service.mjs';

export const workflowMigrationV19Routes = [
  makeRoute('GET', '/workflow-migrations', async ({ req, res }) => {
    const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const migration = await getWorkflowMigrationState();
    const visibleProjectIds = assertMigrationVisible(state, migration.batch, actor?.id, req);
    return send(res, 200, scopeMigrationState(state, migration, visibleProjectIds));
  }),
  makeRoute('POST', '/workflow-migrations/batches/:id/approve', approveBatch),
  makeRoute('POST', '/workflow-migrations/batches/:id/cancel', cancelBatch),
  makeRoute('POST', '/workflow-migrations/jobs/:id/retry', retryJob)
];

async function approveBatch({ req, res, params, body, query }) {
  const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }), batch = findBatch(state, params.id);
  assertMigrationOwner(state, batch, actor?.id, req);
  const approved = await approveWorkflowMigrationBatch(params.id, { ...body, adapter: body.adapter || query.adapter }, actor?.id);
  return send(res, 202, { operation: approved, batch: approved });
}

async function cancelBatch({ req, res, params }) {
  const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }), batch = findBatch(state, params.id);
  assertMigrationOwner(state, batch, actor?.id, req);
  return send(res, 202, await cancelWorkflowMigrationBatch(params.id, actor?.id));
}

async function retryJob({ req, res, params, body }) {
  const state = await readState(), job = state.workflow_migration_jobs.find((item) => item.id === params.id);
  if (!job) throw new HttpError(404, { error: 'workflow_migration_job_not_found' });
  const batch = findBatch(state, job.batch_id);
  const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertMigrationOwner(state, batch, actor?.id, req);
  return send(res, 202, await retryWorkflowMigrationJob(params.id, body));
}

function findBatch(state, batchId) {
  const batch = state.workflow_migration_batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, { error: 'workflow_migration_batch_not_found' });
  return batch;
}

function batchProjectIds(state, batch) {
  if (!batch) return [];
  if (Array.isArray(batch.project_ids) && batch.project_ids.length) return batch.project_ids;
  return [...new Set((batch.workflow_ids || []).map((workflowId) => state.workflows.find((item) => item.id === workflowId)?.project_id).filter(Boolean))];
}

function assertMigrationVisible(state, batch, actorId, req) {
  const projectIds = batchProjectIds(state, batch);
  if (!projectIds.length) {
    if (actorId !== instanceOwnerId(state)) throw new HttpError(403, { error: 'workflow_migration_owner_required' });
    return accessibleProjectIds(state, actorId);
  }
  const allowed = accessibleProjectIds(state, actorId), tokenProjects = new Set(req.auth?.extra?.project_allowlist || []);
  const visible = new Set(projectIds.filter((projectId) => allowed.has(projectId) && (!tokenProjects.size || tokenProjects.has(projectId))));
  if (!visible.size) throw new HttpError(403, { error: 'project_access_denied', action: 'workflow_migration_read' });
  return visible;
}

function assertMigrationOwner(state, batch, actorId, req) {
  const projectIds = batchProjectIds(state, batch);
  if (!projectIds.length) {
    if (actorId !== instanceOwnerId(state)) throw new HttpError(403, { error: 'workflow_migration_owner_required' });
    return;
  }
  const tokenProjects = new Set(req.auth?.extra?.project_allowlist || []), denied = tokenProjects.size ? projectIds.filter((projectId) => !tokenProjects.has(projectId)) : [];
  if (denied.length) throw new HttpError(403, { error: 'mcp_project_access_denied', project_ids: denied });
  const nonOwners = projectIds.filter((projectId) => membershipFor(state, projectId, actorId)?.role !== 'owner');
  if (nonOwners.length) throw new HttpError(403, { error: 'workflow_migration_owner_required', project_ids: nonOwners });
}

function scopeMigrationState(state, migration, visibleProjectIds) {
  const jobs = migration.jobs.filter((item) => visibleProjectIds.has(item.project_id)), workflowProjects = new Map(state.workflows.map((item) => [item.id, item.project_id]));
  const workflowIds = new Set(jobs.map((item) => item.workflow_id));
  for (const workflowId of migration.batch?.workflow_ids || []) if (visibleProjectIds.has(workflowProjects.get(workflowId))) workflowIds.add(workflowId);
  const batch = migration.batch ? { ...migration.batch, project_ids: (migration.batch.project_ids || []).filter((id) => visibleProjectIds.has(id)), workflow_ids: [...workflowIds] } : null;
  if (batch) batch.status = scopedBatchStatus(batch.status, jobs);
  if (batch?.summary) batch.summary = { total: jobs.length, completed: jobs.filter((item) => item.status === 'completed').length, failed: jobs.filter((item) => item.status === 'failed').length };
  return { batch, jobs, legacy_workflow_ids: migration.legacy_workflow_ids.filter((id) => visibleProjectIds.has(workflowProjects.get(id))) };
}

function scopedBatchStatus(status, jobs) {
  if (!jobs.length || status === 'cancelled') return status;
  if (jobs.some((item) => item.status === 'generating')) return 'running';
  if (jobs.some((item) => item.status === 'waiting_active_runs')) return 'waiting_active_runs';
  if (jobs.some((item) => item.status === 'pending')) return status === 'pending_approval' ? status : status === 'approved' ? status : 'running';
  if (jobs.some((item) => item.status === 'failed')) return 'completed_with_failures';
  return jobs.every((item) => item.status === 'cancelled') ? 'cancelled' : 'completed';
}
