import { buildContextPack } from '../../../packages/context-pack/src/index.mjs';
import { executeNodeRun } from '../../api/src/routes/runs.mjs';
import { pathToFileURL } from 'node:url';

export const taskNames = [
  'context-pack.build',
  'node-run.execute'
];

export async function executeTask(name, payload) {
  if (name === 'context-pack.build') return buildContextPack(payload);
  if (name === 'node-run.execute') {
    if (!payload?.node_id) throw new Error('node_id_required');
    return executeNodeRun(payload.node_id, payload.run || payload);
  }
  throw new Error(`unsupported_worker_task:${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`AIWS worker ready: ${taskNames.join(', ')}`);
}
