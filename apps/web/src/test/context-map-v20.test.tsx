import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMapPage } from '../features/context/ContextMapPage';

const projectNode = {
  id: 'context-project',
  uri: 'aiws://context/nodes/context-project',
  kind: 'project',
  source_type: 'state',
  title: '上下文测试项目',
  summary: '确定性项目摘要',
  project_id: 'project-1',
  parent_id: null,
  source_collection: 'projects',
  source_id: 'project-1',
  source_version: 2,
  status: 'active',
  sensitivity: 'internal',
  authority: 'authoritative',
  freshness: { status: 'current', source_updated_at: '2026-07-26T08:00:00.000Z' },
  current_version_id: 'context-version-2',
  required_scopes: ['context:read', 'project:read'],
  sort: { type_order: 10, order_index: 0, stable_id: 'project-1' },
  resource: null
};

const mapResponse = {
  schema_version: 'aiws.context_map.v1',
  uri: 'aiws://context/map/projects/project-1',
  project_id: 'project-1',
  root_id: projectNode.id,
  snapshot_hash: 'a'.repeat(64),
  nodes: [projectNode],
  edges: [],
  compact_markdown: '- [project] 上下文测试项目',
  policy: {
    session_id: null,
    project_id: 'project-1',
    pinned_node_ids: [],
    excluded_node_ids: [],
    revision: 0
  },
  latest_selection: {
    id: 'selection-1',
    schema_version: 'aiws.context_selection.v1',
    actor_id: 'owner',
    session_id: null,
    project_id: 'project-1',
    anchor_node_id: projectNode.id,
    candidate_node_ids: [projectNode.id],
    included: [
      {
        node_id: projectNode.id,
        document_version_id: 'context-version-2',
        content_sha256: 'b'.repeat(64),
        token_estimate: 120,
        reason: 'current_anchor'
      }
    ],
    excluded: [],
    token_budget: 4000,
    token_used: 120,
    map_snapshot_hash: 'c'.repeat(64),
    created_at: '2026-07-26T08:00:00.000Z'
  },
  coverage: { source_records: 1, projected_records: 1, tombstones: 0, warnings: [] }
};

const nodeResponse = {
  schema_version: 'aiws.context_document.v1',
  node: projectNode,
  version: {
    id: 'context-version-2',
    node_id: projectNode.id,
    version: 2,
    renderer_version: 'aiws.context-markdown.v1',
    source_hash: 'd'.repeat(64),
    content_sha256: 'b'.repeat(64),
    size_bytes: 500,
    media_type: 'text/markdown; charset=utf-8',
    token_estimate: 120,
    deterministic_summary: projectNode.summary,
    redactions: [{ path: '$.password', reason: 'sensitive_field' }],
    created_at: '2026-07-26T08:00:00.000Z'
  },
  markdown: '# 上下文测试项目\n\n## 完整事实\n\n项目事实正文',
  facts: { id: 'project-1', title: '上下文测试项目' },
  edges: [],
  related_nodes: [],
  history: [
    {
      id: 'context-version-2',
      node_id: projectNode.id,
      version: 2,
      renderer_version: 'aiws.context-markdown.v1',
      source_hash: 'd'.repeat(64),
      content_sha256: 'b'.repeat(64),
      size_bytes: 500,
      media_type: 'text/markdown; charset=utf-8',
      token_estimate: 120,
      deterministic_summary: projectNode.summary,
      redactions: [],
      created_at: '2026-07-26T08:00:00.000Z'
    }
  ]
};

describe('V2.0 Context Map', () => {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({ url, method, body });
        if (url.includes('/context/v1/nodes/')) return response(nodeResponse);
        if (url.includes('/context/v1/browser-state')) return response(projectNode);
        if (url.includes('/context/v1/search'))
          return response({
            schema_version: 'aiws.context_search.v1',
            query: body?.query,
            project_id: 'project-1',
            snapshot_hash: mapResponse.snapshot_hash,
            results: [{ ...projectNode, score: 100, terms: ['上下文'] }],
            candidate_node_ids: [projectNode.id]
          });
        if (url.includes('/context/v1/policy') && method === 'PUT')
          return response({ ...mapResponse.policy, ...body, revision: 1 });
        if (url.includes('/context/v1/map')) return response(mapResponse);
        return response({ error: 'not_found' }, 404);
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('supports map, summary/source/structure/history, search, policy, selection audit and semantic reporting', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '上下文地图' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '上下文测试项目' })).toBeInTheDocument();
    expect(screen.getByText('确定性项目摘要')).toBeInTheDocument();
    expect(screen.getByText('120/4000 令牌')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /原文/ }));
    expect(screen.getByText(/项目事实正文/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /结构/ }));
    expect(screen.getByText(/"title": "上下文测试项目"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /历史/ }));
    expect(screen.getByText('v2')).toBeInTheDocument();

    const search = screen.getByRole('search');
    fireEvent.change(search.querySelector('input')!, { target: { value: '上下文' } });
    fireEvent.submit(search);
    await waitFor(() => expect(requests.some((item) => item.url.includes('/context/v1/search'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '固定节点' }));
    await waitFor(() =>
      expect(requests.some((item) => item.url.includes('/context/v1/policy') && item.method === 'PUT')).toBe(true)
    );

    await waitFor(() => expect(requests.some((item) => item.url.includes('/context/v1/browser-state'))).toBe(true), {
      timeout: 2000
    });
    const semantic = requests.find((item) => item.url.includes('/context/v1/browser-state'))?.body;
    expect(semantic).toMatchObject({
      project_id: 'project-1',
      route: '/projects/project-1/context',
      selected_node_id: projectNode.id
    });
    expect(semantic).not.toHaveProperty('mouse');
    expect(semantic).not.toHaveProperty('layout');
    expect(semantic).not.toHaveProperty('toast');
  });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/project-1/context']}>
        <Routes>
          <Route path="/projects/:projectId/context" element={<ContextMapPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
