import { parseArgs, runCommand, runCommandSync } from './v175-lib.mjs';

const args = parseArgs(), runId = String(args['run-id'] || '');
if (!/^[A-Za-z0-9_.-]{6,160}$/.test(runId)) {
  console.error('valid --run-id is required');
  process.exit(2);
}

const filter = `label=aiws.test_run=${runId}`;
const resources = [
  { kind: 'container', list: ['docker', 'ps', '-aq', '--filter', filter], remove: ['docker', 'rm', '-f'] },
  { kind: 'volume', list: ['docker', 'volume', 'ls', '-q', '--filter', filter], remove: ['docker', 'volume', 'rm', '-f'] },
  { kind: 'network', list: ['docker', 'network', 'ls', '-q', '--filter', filter], remove: ['docker', 'network', 'rm'] },
  { kind: 'image', list: ['docker', 'images', '-q', '--filter', filter], remove: ['docker', 'image', 'rm', '-f'] }
];
const failures = [];
for (const resource of resources) {
  const listed = runCommandSync(resource.list);
  if (listed.status !== 0) { if (!/not recognized|not found|ENOENT/i.test(listed.stderr || listed.error?.message || '')) failures.push(`${resource.kind}: list failed`); continue; }
  const ids = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))];
  for (const id of ids) {
    const removed = await runCommand([...resource.remove, id], { timeout: 60000 });
    if (removed.status !== 0) failures.push(`${resource.kind}:${id}`);
  }
  console.log(`[v175-cleanup] ${resource.kind}: ${ids.length}`);
}
if (failures.length) { console.error(`cleanup failed: ${failures.join(', ')}`); process.exit(1); }
