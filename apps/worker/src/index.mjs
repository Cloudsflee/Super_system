import { buildContextPack } from '../../../packages/context-pack/src/index.mjs';
import { runMock } from '../../../packages/runner-adapters/src/index.mjs';

export const taskNames = [
  'context-pack.build',
  'memory.sufficiency-check',
  'memory.manifest-build',
  'assist.run',
  'node-run.execute',
  'codex.run',
  'git.capture-diff',
  'git.commit',
  'github.verify-account',
  'github.create-pr',
  'mcp.health-check',
  'digest.generate'
];

export async function executeTask(name, payload) {
  if (name === 'context-pack.build') return buildContextPack(payload);
  if (name === 'node-run.execute') return runMock(payload);
  return { status: 'queued-noop', name, payload_keys: Object.keys(payload || {}) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`AIWS worker ready: ${taskNames.join(', ')}`);
}
