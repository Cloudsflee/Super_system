import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connectMcp(baseUrl, token) {
  const client = new Client({ name: 'aiws-live-project-smoke', version: '1.9.0' }, { capabilities: { resources: { subscribe: true } } });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', `${baseUrl}/`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);

  async function callTool(name, args) {
    const response = await client.callTool({ name, arguments: args });
    if (response.structuredContent) return response.structuredContent;
    const text = response.content?.find((item) => item.type === 'text')?.text || '';
    try { return JSON.parse(text || '{}'); }
    catch { const error = new Error(text || 'mcp_tool_result_invalid'); error.details = { tool: name }; throw error; }
  }
  function callOperation(operationId, args) {
    const domain = operationId.split('.')[1];
    return callTool(`aiws_${domain}`, { action: operationId, arguments: args });
  }
  async function mustOperation(operationId, args) {
    const result = await callOperation(operationId, args);
    if (!result.ok) throw operationError(result);
    return result;
  }
  async function waitForOperation(operationId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await callTool('aiws_operations', {
        action: 'wait', operation_id: operationId, timeout_ms: Math.min(30_000, deadline - Date.now()), poll_ms: 250
      });
      if (!result.ok) throw operationError(result);
      if (result.data.operation.terminal) return result.data.operation;
    }
    throw new Error(`operation_timeout:${operationId}`);
  }
  async function readResource(uri) {
    const response = await client.readResource({ uri });
    const value = JSON.parse(response.contents[0].text);
    if (!value.ok) throw operationError(value);
    return value;
  }
  async function close() {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
  return { client, callTool, callOperation, mustOperation, waitForOperation, readResource, close };
}

export async function createRepositoryWithVisibilityRetry({ mcp, repositoryName, projectId, installationId, operationKey }) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const result = await mcp.callOperation('aiws.github.post.projects.by-id.github.repository', {
      params: { id: projectId },
      body: {
        installation_id: installationId, name: repositoryName,
        description: 'Private repository created by the AIWS V1.9 MCP live smoke test.',
        private: true, auto_init: true, operation_key: operationKey
      }
    });
    const data = dataOf(result);
    if (result.ok && data?.canonical_repository && data?.binding?.status === 'ready') return result;
    const code = result.error?.error || data?.error;
    if (!['access_required', 'github_installation_pending'].includes(code) && data?.status !== 'pending') throw operationError(result);
    if (attempt === 8) throw operationError(result);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    await mcp.mustOperation('aiws.github.post.github.repositories.sync', { body: {} });
  }
  throw new Error('repository_visibility_retry_exhausted');
}

export async function adminJson(baseUrl, pathname, { method = 'GET', ownerId = null, body = undefined } = {}) {
  const response = await fetch(new URL(pathname, `${baseUrl}/`), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(ownerId ? { 'x-aiws-user-id': ownerId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${data.error || data.message || 'request_failed'}`);
  return data;
}

export function dataOf(result) { return result?.handle?.data ?? result?.data; }
export function publicError(error) { return { message: String(error?.message || error), details: error?.details || null }; }
export function normalizeBaseUrl(value) { const url = new URL(String(value)); assert.ok(['http:', 'https:'].includes(url.protocol)); assert.equal(url.username || url.password, ''); return url.href.replace(/\/$/, ''); }

function operationError(result) { const error = new Error(result?.error?.error || 'mcp_operation_failed'); error.details = result?.error || result; return error; }
