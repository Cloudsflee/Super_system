import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callOperation, createMcpTestFixture, resultData } from './mcp-test-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-compat-');
let connection;
try {
  connection = await fixture.connect();
  const legacyResponse = await fetch(`${fixture.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Legacy HTTP client', operation_key: 'v18-legacy-http' })
  });
  assert.equal(legacyResponse.status, 201);
  const legacy = await legacyResponse.json();
  const viaMcp = resultData(
    await callOperation(connection.client, 'aiws.projects.get.projects.by-id', { params: { id: legacy.project.id } })
  );
  assert.equal(viaMcp.project.id, legacy.project.id);

  const modern = resultData(
    await callOperation(connection.client, 'aiws.projects.post.projects', {
      body: { title: 'MCP visible to legacy HTTP' }
    })
  );
  const listResponse = await fetch(`${fixture.baseUrl}/api/projects`);
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(
    list.some((item) => item.id === modern.project.id),
    true
  );

  const webClient = fs.readFileSync('apps/web/src/api/client.ts', 'utf8');
  assert.match(webClient, /\/api/);
  assert.equal(webClient.includes('aiws_execute'), false, 'existing web UI remains an HTTP client');
  const settings = fs.readFileSync('apps/web/src/features/settings/SettingsPage.tsx', 'utf8');
  assert.match(settings, /MCP Clients/);
  assert.match(settings, /\/mcp\/clients/);
  console.log('V1.8 HTTP/UI compatibility tests passed');
} finally {
  await connection?.close();
  await fixture.close();
}
