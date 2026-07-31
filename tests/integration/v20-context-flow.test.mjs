import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v20-context-');
const port = 4946;
const baseUrl = `http://127.0.0.1:${port}`;
const sentinel = 'V20_SECRET_SENTINEL_8c7813';
const foreignTitleCanary = 'ForeignCanary7F42';
let server;
let stateApi;

try {
  server = await startApi({
    port,
    home: fixture.home,
    ccSwitch: fixture.ccSwitch,
    env: { AIWS_CONTEXT_REPOSITORY_FILE_LIMIT: '2' }
  });
  process.env.AIWS_HOME = fixture.home;
  process.env.NODE_ENV = 'test';
  stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const account = await request('/account/me');
  const ownerId = account.user.id;
  const first = await request(
    '/projects',
    'POST',
    { title: '中文上下文项目', goal: '验证系统地图' },
    { 'x-aiws-user-id': ownerId, 'x-aiws-scopes': 'project:create' },
    201
  );
  const second = await request(
    '/projects',
    'POST',
    { title: `隔离项目 ${foreignTitleCanary}`, goal: '不可跨项目读取' },
    { 'x-aiws-user-id': ownerId, 'x-aiws-scopes': 'project:create' },
    201
  );
  const firstId = first.project.id;
  const secondId = second.project.id;
  const repository = path.join(fixture.root, 'repository');
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'README.md'),
    `# 仓库上下文\n\n正文事实。宿主路径 C:\\Users\\owner\\private-repository 不应泄漏。\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(repository, 'diagram.bin'), Buffer.from([0, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(repository, 'zz-omitted.md'), '# 超出仓库投影文件上限\n', 'utf8');
  fs.writeFileSync(path.join(repository, '.env'), `API_TOKEN=${sentinel}\n`, 'utf8');
  fs.writeFileSync(path.join(repository, '.npmrc'), `//registry.npmjs.org/:_authToken=${sentinel}\n`, 'utf8');
  const artifactFile = path.join(fixture.home, 'artifacts', 'context', 'artifact.md');
  const attachmentFile = path.join(fixture.home, 'attachments', firstId, 'attachment.bin');
  const artifactBytes = Buffer.from('Artifact 全文内容', 'utf8');
  const attachmentBytes = Buffer.from([5, 4, 3, 2, 1, 0]);
  const casBytes = Buffer.from('CAS 全文内容', 'utf8');
  const artifactSha = sha256(artifactBytes);
  const attachmentSha = sha256(attachmentBytes);
  const casSha = sha256(casBytes);
  const casStoragePath = path.posix.join('sha256', casSha.slice(0, 2), casSha.slice(2, 4), casSha);
  fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.mkdirSync(path.dirname(attachmentFile), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(fixture.home, 'cas', casStoragePath)), { recursive: true });
  fs.writeFileSync(artifactFile, artifactBytes);
  fs.writeFileSync(attachmentFile, attachmentBytes);
  fs.writeFileSync(path.join(fixture.home, 'cas', casStoragePath), casBytes);
  const ownerHeaders = auth(ownerId, [
    'context:read',
    'context:admin',
    'system:read',
    'project:read',
    'workflow:read',
    'assets:read',
    'files:read',
    'runs:read',
    'assist:read',
    'setup:read',
    'governance:read',
    'approval:read',
    'github:read',
    'git:read',
    'terminal:read',
    'exchange:read'
  ]);

  await patchState((state) => {
    const project = state.projects.find((item) => item.id === firstId);
    project.password = sentinel;
    project.repo_path = repository;
    project.host_path = 'C:\\Users\\owner\\private-repository';
    project.updated_at = '2026-07-26T08:00:00.000Z';
    state.users.push({
      ...state.users.find((item) => item.id === ownerId),
      id: 'user-context-viewer',
      role: 'member',
      auth_mode: 'test'
    });
    state.project_memberships.push({
      id: 'membership-context-viewer',
      project_id: firstId,
      user_id: 'user-context-viewer',
      role: 'viewer',
      status: 'active',
      source: 'test',
      invited_by_user_id: ownerId,
      github_identity: null,
      accepted_at: '2026-07-26T08:00:00.000Z',
      revoked_at: null,
      created_at: '2026-07-26T08:00:00.000Z',
      updated_at: '2026-07-26T08:00:00.000Z'
    });
    state.file_refs.push({
      id: 'file-context-artifact',
      project_id: firstId,
      kind: 'context-test',
      absolute_path: artifactFile,
      relative_path: 'artifacts/context/artifact.md',
      sha256: artifactSha,
      size_bytes: artifactBytes.length,
      content_type: 'text/markdown',
      created_at: '2026-07-26T08:00:00.000Z'
    });
    state.attachments.push({
      id: 'attachment-context-binary',
      project_id: firstId,
      title: '上下文二进制附件',
      managed_path: attachmentFile,
      storage_status: 'ready',
      sha256: attachmentSha,
      size_bytes: attachmentBytes.length,
      content_type: 'application/octet-stream',
      status: 'ready',
      created_at: '2026-07-26T08:00:00.000Z',
      updated_at: '2026-07-26T08:00:00.000Z'
    });
    state.asset_blobs.push({
      id: `blob_${casSha}`,
      project_id: firstId,
      sha256: casSha,
      size_bytes: casBytes.length,
      media_type: 'text/plain',
      storage_path: casStoragePath,
      created_at: '2026-07-26T08:00:00.000Z'
    });
  });

  const map = await request(
    `/context/v1/map?project_id=${encodeURIComponent(firstId)}`,
    'GET',
    undefined,
    ownerHeaders
  );
  assert.equal(map.schema_version, 'aiws.context_map.v1');
  assert.equal(map.project_id, firstId);
  assert.match(map.uri, /^aiws:\/\/context\/map\/projects\//);
  assert.ok(map.compact_markdown.includes('中文上下文项目'));
  const projectNode = map.nodes.find((node) => node.source_collection === 'projects' && node.source_id === firstId);
  assert.ok(projectNode?.current_version_id);
  const repositoryTextNode = map.nodes.find((node) => node.resource?.relative_path === 'README.md');
  const repositoryBinaryNode = map.nodes.find((node) => node.resource?.relative_path === 'diagram.bin');
  const repositoryManifestNode = map.nodes.find((node) => node.resource?.adapter === 'repository_manifest.v1');
  assert.ok(repositoryTextNode?.current_version_id);
  assert.ok(repositoryBinaryNode?.current_version_id);
  assert.equal(repositoryManifestNode?.resource?.manifest?.status, 'truncated');
  assert.equal(repositoryManifestNode?.resource?.manifest?.omitted_file_count, 1);
  assert.equal(
    map.nodes.some((node) => node.resource?.relative_path === 'zz-omitted.md'),
    false
  );
  assert.equal(
    map.nodes.some((node) => node.resource?.relative_path === '.env'),
    false
  );
  assert.equal(
    map.nodes.some((node) => node.resource?.relative_path === '.npmrc'),
    false
  );
  const artifactNode = map.nodes.find((node) => node.source_id === 'file-context-artifact');
  const attachmentNode = map.nodes.find((node) => node.source_id === 'attachment-context-binary');
  const casNode = map.nodes.find((node) => node.source_id === `blob_${casSha}`);
  assert.ok(artifactNode && attachmentNode && casNode);

  const search = await request(
    '/context/v1/search',
    'POST',
    { project_id: firstId, query: '中文上下文', limit: 10 },
    ownerHeaders
  );
  assert.ok(search.results.some((item) => item.id === projectNode.id));
  assert.ok(search.candidate_node_ids.includes(projectNode.id));

  const document = await request(`/context/v1/nodes/${projectNode.id}`, 'GET', undefined, ownerHeaders);
  assert.equal(document.version.id, projectNode.current_version_id);
  assert.equal(document.markdown.includes(sentinel), false);
  assert.equal(document.markdown.includes('C:\\Users\\owner'), false);
  assert.match(document.markdown, /\[已脱敏\]/);
  assert.match(document.markdown, /\[宿主机路径已隐藏\]/);

  const repositoryText = await request(`/context/v1/nodes/${repositoryTextNode.id}`, 'GET', undefined, ownerHeaders);
  assert.match(repositoryText.markdown, /正文事实/);
  assert.equal(repositoryText.markdown.includes('C:\\Users\\owner'), false);
  const repositoryBinary = await request(
    `/context/v1/nodes/${repositoryBinaryNode.id}`,
    'GET',
    undefined,
    ownerHeaders
  );
  assert.match(repositoryBinary.markdown, /"binary": true/);
  assert.equal(repositoryBinary.markdown.includes('API_TOKEN'), false);
  assert.match(
    (await request(`/context/v1/nodes/${artifactNode.id}`, 'GET', undefined, ownerHeaders)).markdown,
    /Artifact 全文内容/
  );
  assert.match(
    (await request(`/context/v1/nodes/${attachmentNode.id}`, 'GET', undefined, ownerHeaders)).markdown,
    /"binary": true/
  );
  assert.match(
    (await request(`/context/v1/nodes/${casNode.id}`, 'GET', undefined, ownerHeaders)).markdown,
    /CAS 全文内容/
  );

  const browserState = await request(
    '/context/v1/browser-state',
    'POST',
    {
      project_id: firstId,
      browser_id: 'browser-context-test',
      route: `/projects/${firstId}/context?ignored=1`,
      selected_node_id: projectNode.id,
      tab: 'structure',
      filters: { query: '中文', hover_target: 'not-recorded', toast: 'not-recorded', active: true },
      mouse_x: 120,
      pixel_layout: 'not-recorded'
    },
    ownerHeaders
  );
  assert.equal(browserState.source_type, 'resource');
  assert.equal(browserState.resource.manifest.filters.hover_target, undefined);
  assert.equal(browserState.resource.manifest.filters.toast, undefined);
  const mapWithBrowser = await request(
    `/context/v1/map?project_id=${encodeURIComponent(firstId)}`,
    'GET',
    undefined,
    ownerHeaders
  );
  const browserNode = mapWithBrowser.nodes.find((node) => node.id === browserState.id);
  const browserDocument = await request(`/context/v1/nodes/${browserNode.id}`, 'GET', undefined, ownerHeaders);
  assert.equal(browserDocument.facts.route, `/projects/${firstId}/context`);
  assert.deepEqual(browserDocument.facts.filters, { active: true, query: '中文' });
  assert.equal(JSON.stringify(browserDocument.facts).includes('mouse_x'), false);
  assert.equal(JSON.stringify(browserDocument.facts).includes('pixel_layout'), false);

  const selection = await request(
    '/context/v1/selections',
    'POST',
    { project_id: firstId, candidate_node_ids: [projectNode.id], token_budget: 20_000 },
    ownerHeaders,
    201
  );
  assert.equal(selection.schema_version, 'aiws.context_selection.v2');
  const selectedProjectDocument = await request(`/context/v1/nodes/${projectNode.id}`, 'GET', undefined, ownerHeaders);
  assert.equal(selection.included[0].document_version_id, selectedProjectDocument.version.id);
  const selectedVersionId = selectedProjectDocument.version.id;
  const explanation = await request(`/context/v1/selections/${selection.id}`, 'GET', undefined, ownerHeaders);
  assert.equal(explanation.included_nodes[0].node.id, projectNode.id);
  assert.equal(JSON.stringify(explanation).includes(sentinel), false);

  const policy = await request(
    '/context/v1/policy',
    'PUT',
    { project_id: firstId, pinned_node_ids: [projectNode.id], excluded_node_ids: [] },
    ownerHeaders
  );
  assert.deepEqual(policy.pinned_node_ids, [projectNode.id]);
  assert.equal(
    (await request(`/context/v1/policy?project_id=${encodeURIComponent(firstId)}`, 'GET', undefined, ownerHeaders))
      .revision,
    1
  );

  await patchState((state) => {
    const project = state.projects.find((item) => item.id === firstId);
    project.title = '中文上下文项目 V2';
    project.updated_at = '2026-07-26T09:00:00.000Z';
  });
  const version2Map = await request(
    `/context/v1/map?project_id=${encodeURIComponent(firstId)}`,
    'GET',
    undefined,
    ownerHeaders
  );
  const version2Id = version2Map.nodes.find((node) => node.id === projectNode.id).current_version_id;
  assert.notEqual(version2Id, selectedVersionId);
  await patchState((state) => {
    const project = state.projects.find((item) => item.id === firstId);
    project.title = '中文上下文项目 V3';
    project.updated_at = '2026-07-26T10:00:00.000Z';
  });
  const version3Map = await request(
    `/context/v1/map?project_id=${encodeURIComponent(firstId)}`,
    'GET',
    undefined,
    ownerHeaders
  );
  const version3Node = version3Map.nodes.find((node) => node.id === projectNode.id);
  assert.notEqual(version3Node.current_version_id, version2Id);
  const version3Document = await request(`/context/v1/nodes/${projectNode.id}`, 'GET', undefined, ownerHeaders);
  assert.ok(version3Document.history.some((item) => item.id === selectedVersionId));
  assert.equal(
    version3Document.history.some((item) => item.id === version2Id),
    true
  );
  assert.equal(
    (
      await request(
        `/context/v1/nodes/${projectNode.id}?version_id=${encodeURIComponent(selectedVersionId)}`,
        'GET',
        undefined,
        ownerHeaders
      )
    ).version.id,
    selectedVersionId
  );

  const secondMap = await request(
    `/context/v1/map?project_id=${encodeURIComponent(secondId)}`,
    'GET',
    undefined,
    ownerHeaders
  );
  const secondNode = secondMap.nodes.find(
    (node) => node.source_collection === 'projects' && node.source_id === secondId
  );
  const viewerHeaders = auth('user-context-viewer', ['context:read', 'project:read']);
  await patchState((state) => {
    state.file_refs.push({
      id: 'file-inaccessible-project-failure',
      project_id: secondId,
      kind: 'context-test',
      absolute_path: path.join(fixture.home, 'artifacts', 'missing.md'),
      relative_path: 'artifacts/missing.md',
      sha256: '0'.repeat(64),
      size_bytes: 1,
      content_type: 'text/markdown',
      created_at: '2026-07-26T10:30:00.000Z'
    });
    state.context_resource_coverage ||= { repositories: [], warnings: [] };
    const secondReport = state.context_resource_coverage.repositories.find((report) => report.project_id === secondId);
    Object.assign(secondReport, {
      status: 'truncated',
      complete: false,
      included_file_count: 1,
      omitted_file_count: 7,
      file_limit: 1
    });
  });
  const viewerGlobalMap = await request('/context/v1/map', 'GET', undefined, viewerHeaders);
  assert.equal(
    (await readState()).context_projection_coverage.warnings.some((warning) => warning.project_id === secondId),
    true,
    'fixture must retain an inaccessible-project coverage warning in authoritative state'
  );
  assert.equal(
    JSON.stringify(viewerGlobalMap.coverage).includes(secondId),
    false,
    'public coverage must not reveal inaccessible project metadata'
  );
  assert.equal(
    viewerGlobalMap.coverage.warnings.some((warning) => String(warning.code || '').startsWith('context_repository_')),
    false,
    'repository coverage requires files:read in addition to project ACL'
  );
  assert.equal(
    viewerGlobalMap.nodes.some((node) => node.project_id === secondId),
    false,
    'global map must not materialize or reveal an inaccessible project'
  );
  const viewerRootDocument = await request('/context/v1/nodes/ctx_root_system', 'GET', undefined, viewerHeaders);
  assert.equal(viewerRootDocument.markdown.includes(second.project.title), false);
  assert.equal(viewerRootDocument.markdown.includes(secondId), false);
  assert.equal(
    viewerRootDocument.related_nodes.some((node) => node.project_id === secondId),
    false
  );
  const viewerForeignSearch = await request('/context/v1/search', 'POST', { query: foreignTitleCanary }, viewerHeaders);
  assert.equal(viewerForeignSearch.results.length, 0, 'global relation index must not reveal an inaccessible project');
  await request(`/context/v1/nodes/${secondNode.id}`, 'GET', undefined, viewerHeaders, 403);
  await request(
    `/context/v1/nodes/${projectNode.id}`,
    'GET',
    undefined,
    auth('user-context-viewer', ['context:read']),
    403
  );
  await request(
    '/context/v1/policy',
    'PUT',
    { project_id: firstId, pinned_node_ids: [secondNode.id], excluded_node_ids: [] },
    viewerHeaders,
    403
  );
  await request(
    '/context/v1/search',
    'POST',
    { project_id: firstId, query: '上下文', anchor_node_id: secondNode.id },
    viewerHeaders,
    403
  );
  await request(
    '/context/v1/policy',
    'PUT',
    { project_id: firstId, pinned_node_ids: ['ctx_root_system'], excluded_node_ids: [] },
    viewerHeaders,
    403
  );

  const viewerGlobalSelection = await request(
    '/context/v1/selections',
    'POST',
    { candidate_node_ids: [projectNode.id], token_budget: 20_000 },
    viewerHeaders,
    201
  );
  assert.equal(viewerGlobalSelection.included[0].node_id, projectNode.id);
  await patchState((state) => {
    const membership = state.project_memberships.find((item) => item.id === 'membership-context-viewer');
    membership.status = 'revoked';
    membership.revoked_at = '2026-07-26T11:00:00.000Z';
    membership.updated_at = membership.revoked_at;
  });
  const revokedExplanation = await request(
    `/context/v1/selections/${viewerGlobalSelection.id}`,
    'GET',
    undefined,
    viewerHeaders
  );
  assert.equal(revokedExplanation.included_nodes[0].node, null, 'selection audit reapplies current project ACL');

  const status = await request('/context/v1/status', 'GET', undefined, ownerHeaders);
  assert.equal(status.schema_version, 22);
  assert.ok(status.coverage.warnings.some((item) => item.code === 'context_repository_projection_truncated'));
  assert.equal(status.jobs.failed, 0);
  assert.equal(status.index.state, 'ready');

  const projectionState = await readState();
  const protectedProjectionData = JSON.stringify({
    context_nodes: projectionState.context_nodes,
    context_document_versions: projectionState.context_document_versions,
    context_edges: projectionState.context_edges,
    context_selections: projectionState.context_selections,
    context_policies: projectionState.context_policies,
    context_projection_jobs: projectionState.context_projection_jobs,
    context_summaries: projectionState.context_summaries,
    context_projection_coverage: projectionState.context_projection_coverage
  });
  assert.equal(protectedProjectionData.includes(sentinel), false);
  assert.equal(JSON.stringify(projectionState.context_selections).includes(sentinel), false);
  assert.equal(JSON.stringify(projectionState.context_summaries).includes(sentinel), false);
  assertStateFilesExclude(sentinel);
  const indexFile = path.join(fixture.home, 'data', '.context-index', 'minisearch-v2.json');
  assert.equal(fs.readFileSync(indexFile, 'utf8').includes(sentinel), false);
  assert.equal(server.log().includes(sentinel), false);

  await server.stop();
  server = null;
  fs.writeFileSync(indexFile, '{corrupt-index', 'utf8');
  server = await startApi({
    port,
    home: fixture.home,
    ccSwitch: fixture.ccSwitch,
    env: { AIWS_CONTEXT_REPOSITORY_FILE_LIMIT: '2' }
  });
  const rebuiltSearch = await request(
    '/context/v1/search',
    'POST',
    { project_id: firstId, query: '中文上下文' },
    ownerHeaders
  );
  assert.ok(rebuiltSearch.results.some((item) => item.id === projectNode.id));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  assert.equal(fs.readFileSync(indexFile, 'utf8').includes(sentinel), false);
  assert.equal(JSON.stringify(rebuiltSearch).includes(sentinel), false);
  assert.equal(server.log().includes(sentinel), false);

  const current = await readState();
  const currentProjectNode = current.context_nodes.find((node) => node.id === projectNode.id);
  const version = current.context_document_versions.find((item) => item.id === currentProjectNode.current_version_id);
  fs.rmSync(path.join(fixture.home, 'cas', version.cas_ref.storage_path));
  const unavailable = await request(`/context/v1/nodes/${projectNode.id}`, 'GET', undefined, ownerHeaders, 503);
  assert.equal(unavailable.error, 'context_projection_unavailable');

  await server.stop();
  server = null;
  fs.writeFileSync(indexFile, '{corrupt-index', 'utf8');
  server = await startApi({
    port,
    home: fixture.home,
    ccSwitch: fixture.ccSwitch,
    env: { AIWS_CONTEXT_REPOSITORY_FILE_LIMIT: '2' }
  });
  const unavailableSearch = await request(
    '/context/v1/search',
    'POST',
    { project_id: firstId, query: '中文上下文' },
    ownerHeaders,
    503
  );
  assert.equal(unavailableSearch.error, 'context_projection_unavailable');
  assert.equal(unavailableSearch.reason, 'cas_blob_missing');

  console.log('V2.0 context REST, isolation, index recovery, and CAS integrity flow passed');
} finally {
  await server?.stop();
  await stateApi?.checkpointAndCloseState().catch(() => undefined);
  cleanup(fixture.root);
}

function auth(userId, scopes) {
  return { 'x-aiws-user-id': userId, 'x-aiws-scopes': scopes.join(' ') };
}

async function request(route, method = 'GET', body, headers = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

function patchState(apply) {
  return stateApi.mutate(apply);
}

async function readState() {
  return stateApi.readState();
}

function assertStateFilesExclude(value) {
  const needle = Buffer.from(value);
  for (const name of ['state.json', 'state-v22.sqlite', 'state-v22.sqlite-wal']) {
    const file = path.join(fixture.home, 'data', name);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(needle), false, `${name} contains ${value}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
