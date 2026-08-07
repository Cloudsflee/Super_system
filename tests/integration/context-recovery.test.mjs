import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

test('Context Map rebuilds ordered aiws URIs and seals Context Pack v5', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Context fixture' }, 'context-project');
    await mutate(env.base, `/api/v1/projects/${project.json.id}/briefs`, { content: { objective: 'Project context deterministically', acceptance: ['ordered tree'] } }, 'context-brief');
    const first = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/sources`, { kind: 'note', title: 'Architecture signal', content: 'Broker owns the Docker control plane.' }, 'context-source-first');
    const second = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/sources`, { kind: 'note', title: 'Evidence signal', content: 'Evidence uses SHA-256 CAS.' }, 'context-source-second');
    assert.equal(first.response.status, 201);
    const search = await request(env.base, `/api/v1/projects/${project.json.id}/context/sources?q=Evidence`);
    assert.equal(search.json[0].id, second.json.id);

    const rebuilt = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'context-rebuild');
    assert.equal(rebuilt.response.status, 201);
    assert.equal(rebuilt.json.job.status, 'completed');
    assert.equal(rebuilt.json.map.root_uri, `aiws://context/${project.json.id}`);
    assert.equal(rebuilt.json.map.nodes.length, 3);
    assert.deepEqual(rebuilt.json.map.nodes.map((node) => node.uri), rebuilt.json.map.nodes.map((node) => node.uri).toSorted());
    const leaf = rebuilt.json.map.nodes.find((node) => node.kind === 'note');
    const read = await request(env.base, `/api/v1/projects/${project.json.id}/context/read?uri=${encodeURIComponent(leaf.uri)}`);
    assert.equal(read.response.status, 200);
    assert.match(read.json.document.content, /Docker|Evidence/);

    const selection = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/selections`, { node_ids: [leaf.id], retrieval_plan: { strategy: 'explicit', token_budget: 2048 } }, 'context-selection');
    assert.equal(selection.response.status, 201);
    assert.equal(selection.json.retrieval_plan.token_budget, 2048);
    const pack = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/packs`, { source_ids: [first.json.id, second.json.id], selection: 'explicit', retrieval_plan: { strategy: 'ordered', token_budget: 4096 } }, 'context-pack-v5');
    assert.equal(pack.response.status, 201);
    assert.equal(pack.json.pack.schema_version, 'aiws.context_pack.v5');
    assert.equal(pack.json.pack.selection.schema_version, 'aiws.context_selection.v2');
    assert.equal(pack.json.pack.retrieval_plan.token_budget, 4096);
    assert.equal(pack.json.pack.memory_manifest.brief_revision, 1);

    const beforeVersions = (await env.app.database.get('SELECT count(*) AS count FROM context_document_versions')).count;
    await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'context-rebuild-repeat');
    const afterVersions = (await env.app.database.get('SELECT count(*) AS count FROM context_document_versions')).count;
    assert.equal(afterVersions, beforeVersions);
    const interruptedJob = 'cpj_interrupted_fixture';
    const interruptedAt = new Date(Date.now() + 1000).toISOString();
    await env.app.database.run("INSERT INTO context_projection_jobs(id,project_id,status,cursor,created_at,updated_at) VALUES(?,?,?,?,?,?)", [interruptedJob, project.json.id, 'running', '1', interruptedAt, interruptedAt]);
    assert.equal(await env.app.domain.recover(), 0);
    const status = await request(env.base, `/api/v1/projects/${project.json.id}/context/status`);
    assert.equal(status.json.id, interruptedJob);
    assert.equal(status.json.status, 'completed');
    assert.equal(status.json.cursor, '2');
    const recoveredVersions = (await env.app.database.get('SELECT count(*) AS count FROM context_document_versions')).count;
    assert.equal(recoveredVersions, beforeVersions);
  } finally { await env.close(); }
});
