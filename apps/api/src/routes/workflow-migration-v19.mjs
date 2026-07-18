import { makeRoute, send } from '../http.mjs';
import { owner, readState } from '../state.mjs';
import {
  approveWorkflowMigrationBatch, cancelWorkflowMigrationBatch, getWorkflowMigrationState,
  retryWorkflowMigrationJob
} from '../workflow-migration-service.mjs';

export const workflowMigrationV19Routes = [
  makeRoute('GET', '/workflow-migrations', async ({ res }) => send(res, 200, await getWorkflowMigrationState())),
  makeRoute('POST', '/workflow-migrations/batches/:id/approve', approveBatch),
  makeRoute('POST', '/workflow-migrations/batches/:id/cancel', cancelBatch),
  makeRoute('POST', '/workflow-migrations/jobs/:id/retry', async ({ res, params, body }) => send(res, 202, await retryWorkflowMigrationJob(params.id, body)))
];

async function approveBatch({ res, params, body, query }) { const state = await readState(), actor = owner(state); const batch = await approveWorkflowMigrationBatch(params.id, { ...body, adapter: body.adapter || query.adapter }, actor?.id); return send(res, 202, { operation: batch, batch }); }
async function cancelBatch({ res, params }) { const state = await readState(), actor = owner(state); return send(res, 202, await cancelWorkflowMigrationBatch(params.id, actor?.id)); }
