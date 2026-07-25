import { buildContextPack } from '../../../packages/context-pack/src/index.mjs';
import { executeNodeRun } from '../../api/src/routes/runs.mjs';
import { pathToFileURL } from 'node:url';
import { claimTaskExecution, submitTaskExecutionOutputs } from '../../api/src/task-execution-service.mjs';

export const taskNames = [
  'context-pack.build',
  'node-run.execute',
  'task-execution.claim',
  'task-execution.output'
];

export async function executeTask(name, payload) {
  if (name === 'context-pack.build') return buildContextPack(payload);
  if (name === 'node-run.execute') {
    if (!payload?.node_id) throw new Error('node_id_required');
    return executeNodeRun(payload.node_id, payload.run || payload);
  }
  if (name === 'task-execution.claim') {
    if (!payload?.task_execution_id) throw new Error('task_execution_id_required');
    return claimTaskExecution(payload.task_execution_id, payload);
  }
  if (name === 'task-execution.output') {
    if (!payload?.task_execution_id) throw new Error('task_execution_id_required');
    return submitTaskExecutionOutputs(payload.task_execution_id, { outputs: payload.outputs, leaseToken: payload.lease_token, verifierId: payload.verifier_id, actorId: payload.actor_id });
  }
  throw new Error(`unsupported_worker_task:${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`AIWS worker ready: ${taskNames.join(', ')}`);
}
