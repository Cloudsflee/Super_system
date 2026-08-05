const baseUrl = process.env.AIWS_BASE_URL || 'http://127.0.0.1:4317';

async function call(path, body, key) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`);
  return result;
}

const project = await call('/api/v1/projects', {
  name: 'DesignSignal Demo',
  description: 'Sanitized AIWS 3.0 acceptance fixture',
  repository: { local_path: 'projects/designsignal-demo', remote_url: '', head_sha: '0000000000000000000000000000000000000000' }
}, 'demo-project-v3');
await call(`/api/v1/projects/${project.id}/briefs`, {
  content: {
    objective: 'Validate an immutable AI-assisted delivery workflow',
    constraints: ['Local execution', 'Human delivery review'],
    acceptance: ['DAG completes', 'Evidence is addressable', 'Draft PR gate is explicit']
  }
}, 'demo-brief-v3');
await call(`/api/v1/projects/${project.id}/workflows`, {
  name: 'DesignSignal delivery',
  tasks: [
    { id: 'analyze', title: 'Analyze repository signals', level: 1, mode: 'read', outputs: ['analysis.md'] },
    { id: 'verify', title: 'Verify acceptance evidence', level: 1, mode: 'read', outputs: ['test-report.json'] },
    { id: 'deliver', title: 'Apply reviewed change', level: 2, deps: ['analyze', 'verify'], mode: 'write', inputs: ['analysis.md', 'test-report.json'], outputs: ['change.diff'] }
  ]
}, 'demo-workflow-v3');
const source = await call(`/api/v1/projects/${project.id}/context/sources`, {
  kind: 'note', title: 'Acceptance signal', content: 'Use deterministic local evidence and preserve human review boundaries.'
}, 'demo-context-source-v3');
await call(`/api/v1/projects/${project.id}/context/packs`, { source_ids: [source.id], selection: 'explicit' }, 'demo-context-pack-v3');
process.stdout.write(`${JSON.stringify({ project_id: project.id, base_url: baseUrl }, null, 2)}\n`);
