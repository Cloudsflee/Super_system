import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextPage } from '../features/context';
import { SettingsPage, type WorkspacePageProps } from '../pages';
import type { Project } from '../types';

const projectId = 'prj_context_ui';
const timestamp = '2026-08-16T00:00:00.000Z';
const project: Project = {
  id: projectId, name: 'Context UI', description: '', status: 'active', onboarding_state: 'confirmed', revision: 3,
  confirmed_brief_revision: 2, updated_at: timestamp,
  workflow: { project_id: projectId, revision: 4, name: 'Applied workflow', graph_hash: 'a'.repeat(64), created_at: timestamp, tasks: [] }
};
const node = {
  id: 'ctx_note', project_id: projectId, parent_id: 'ctx_root', uri: `aiws://context/${projectId}/context_source/src_note`, title: 'Architecture note', kind: 'note', source_type: 'context_source', source_id: 'src_note', source_revision: '1', source_hash: 'b'.repeat(64), current_document_version_id: 'cdv_note', sensitivity: 'normal', authority: 'observed', status: 'active', revision: 1, required_scopes: ['context:read'], freshness: { status: 'current' }
};

const props: WorkspacePageProps = {
  projectId, selectedProject: project, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined)
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => cleanup());

describe('R5 Context workspace', () => {
  it('reads versioned content, updates policy, seals selections, and exposes projection controls', async () => {
    let pinned: string[] = [];
    const mutations: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input), method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      if (method !== 'GET') mutations.push({ url, body });
      if (url.endsWith(`/api/v1/projects/${projectId}`)) return response(project);
      if (url.endsWith('/context/map')) return response({ schema_version: 'aiws.context_map.v2', project_id: projectId, root_uri: `aiws://context/${projectId}`, nodes: [node], edges: [], index: { status: 'ready', schema_version: 'aiws.context_index.v2', snapshot_hash: 'c'.repeat(64), index_hash: 'd'.repeat(64), document_count: 1 } });
      if (url.endsWith('/context/policy') && method === 'GET') return response({ project_id: projectId, revision: pinned.length ? 2 : 1, hash: 'e'.repeat(64), policy: { pinned_node_ids: pinned, excluded_node_ids: [] } });
      if (url.endsWith('/context/policy') && method === 'PATCH') { pinned = (body.policy as { pinned_node_ids: string[] }).pinned_node_ids; return response({ project_id: projectId, revision: 2, policy: { pinned_node_ids: pinned, excluded_node_ids: [] } }); }
      if (url.endsWith('/context/selections') && method === 'GET') return response([{ id: 'csel_ui', schema_version: 'aiws.context_selection.v2', selection_hash: 'f'.repeat(64), policy_revision: 1, retrieval_plan: { token_budget: 4096 }, included: [{ node_id: node.id, document_version_id: 'cdv_note', token_estimate: 8, reason: 'search_rank' }], excluded: [], token_used: 8, created_at: timestamp }]);
      if (url.endsWith('/context/selections') && method === 'POST') return response({ id: 'csel_new' }, 201);
      if (url.endsWith('/context/packs') && method === 'GET') return response([]);
      if (url.endsWith('/context/packs') && method === 'POST') return response({ id: 'pack_ui' }, 201);
      if (url.endsWith('/context/status')) return response({ id: 'cpj_ui', project_id: projectId, status: 'completed', phase: 'completed', mode: 'full', cursor: '1', revision: 4, attempt: 1, index: { status: 'ready', schema_version: 'aiws.context_index.v2', snapshot_hash: 'c'.repeat(64), index_hash: 'd'.repeat(64), document_count: 1 }, jobs: [] });
      if (url.endsWith(`/context/nodes/${node.id}/versions`)) return response([{ id: 'cdv_note', node_id: node.id, version: 1, content_hash: node.source_hash, token_estimate: 8, renderer_version: 'context-renderer-v5', storage_kind: 'cas', created_at: timestamp }]);
      if (url.includes(`/context/nodes/${node.id}`)) return response({ ...node, document: { id: 'cdv_note', node_id: node.id, version: 1, content_hash: node.source_hash, token_estimate: 8, renderer_version: 'context-renderer-v5', storage_kind: 'cas', created_at: timestamp, content: 'Projected document content' } });
      if (url.endsWith('/context/rebuild') && method === 'POST') return response({ operation_id: 'op_context_ui', status: 'queued', resource_id: 'cpj_ui_2', cursor: 0, revision: 1 }, 202);
      return response({});
    }));

    render(<ContextPage {...props} />);
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeVisible();
    expect(await screen.findByText('Architecture note')).toBeVisible();
    expect(await screen.findByText('Projected document content')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pin node' }));
    await waitFor(() => expect(mutations.some((item) => item.url.endsWith('/context/policy') && (item.body.policy as { pinned_node_ids: string[] }).pinned_node_ids.includes(node.id))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Create Selection' }));
    await waitFor(() => expect(mutations.some((item) => item.url.endsWith('/context/selections'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Seal Pack v5' }));
    await waitFor(() => expect(mutations.some((item) => item.url.endsWith('/context/packs'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(mutations.some((item) => item.url.endsWith('/context/rebuild'))).toBe(true));
  });

  it('creates an explicitly scoped MCP client and shows its one-time token', async () => {
    let clients: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input), method = options?.method || 'GET';
      if (url.endsWith('/api/v1/system/capabilities')) return response({ codex: { status: 'available' }, github: { status: 'available' }, broker: { status: 'available', runner_digest: 'sha256:fixture' } });
      if (url.endsWith('/api/v1/mcp/tools')) return response({ tools: [{ name: 'project.get', description: 'Get project' }] });
      if (url.includes('/api/v1/mcp/scopes')) return response([]);
      if (url.endsWith('/api/v1/mcp/clients') && method === 'GET') return response(clients);
      if (url.endsWith('/api/v1/mcp/clients') && method === 'POST') {
        clients = [{ id: 'mcp_ui', name: 'Local MCP', transport: 'stdio', endpoint: '', status: 'available', revision: 1, subject: 'local-user', token_prefix: 'aiws_mcp_prefix', project_allowlist: [projectId], tool_allowlist: ['project.get'], scope: { project_ids: [projectId], tools: ['project.get'] } }];
        return response({ ...(clients[0] as object), token: 'aiws_mcp_one_time_fixture_token_1234567890' }, 201);
      }
      return response({});
    }));
    render(<SettingsPage {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'MCP' }));
    await screen.findByRole('heading', { name: 'MCP clients' });
    fireEvent.click(screen.getByRole('button', { name: 'Create client' }));
    expect(await screen.findByText('One-time token')).toBeVisible();
    expect(screen.getByText('aiws_mcp_one_time_fixture_token_1234567890')).toBeVisible();
  });
});
