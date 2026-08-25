import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidencePage } from '../features/evidence';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'project_evidence_ui'; const assetId = 'asset_evidence_ui'; const versionId = 'asset_version_ui';
const asset = { id: assetId, project_id: projectId, execution_id: 'execution_evidence_ui', logical_name: 'result.json', asset_kind: 'execution_output', source_type: 'manual', source_ref: 'web:result.json', current_version_id: versionId, current_version: 1, current: { id: versionId, asset_id: assetId, version_no: 1, parser_run_id: null, source_sha256: 'a'.repeat(64), content_sha256: 'a'.repeat(64), metadata: {}, metadata_sha256: 'b'.repeat(64), created_at: '2026-08-24T00:00:00.000Z' }, status: 'active', revision: 3, updated_at: '2026-08-24T00:01:00.000Z' };
const calls: Array<{ url: string; method: string; revision: string | null; body: Record<string, unknown> }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_evidence_ui', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = { projectId, selectedProject: { id: projectId, name: 'Evidence UI', description: '', status: 'active', revision: 4, updated_at: '' }, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined) };

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'GET' && url === `/api/v2/projects/${projectId}/assets`) return envelope({ assets: [asset] });
    if (method === 'GET' && url === '/api/v2/parser/formats') return envelope({ formats: [{ id: 'parser_format_json', format_key: 'json', label: 'JSON', family: 'text', status: 'supported', extensions: ['json'] }] });
    if (method === 'GET' && url === `/api/v2/assets/${assetId}`) return envelope({ asset });
    if (method === 'GET' && url === `/api/v2/assets/${assetId}/versions`) return envelope({ versions: [asset.current] });
    if (method === 'GET' && url === `/api/v2/assets/${assetId}/relations`) return envelope({ relations: [{ id: 'relation_ui', from_asset_id: assetId, to_asset_id: 'asset_source_ui', relation_type: 'derived_from', input_sha256: 'c'.repeat(64), output_sha256: 'a'.repeat(64), created_at: asset.updated_at }] });
    if (method === 'GET' && url === `/api/v2/assets/${assetId}/attestations`) return envelope({ attestations: [] });
    if (method === 'GET' && url.endsWith(`/versions/${versionId}/content`)) return new Response('{"passed":true}', { headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && url === '/api/v2/parser-runs/parser_run_ui') return envelope({ parser_run: { id: 'parser_run_ui', status: 'parsed', attempt_no: 1, retry_of_parser_run_id: null, output_asset_version_id: 'asset_version_parsed_ui', receipt_sha256: 'd'.repeat(64), error_code: '', revision: 2, completed_at: asset.updated_at } });
    const headers = new Headers(options?.headers); const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>; calls.push({ url, method, revision: headers.get('X-Expected-Revision'), body });
    if (url.endsWith('/attestations')) return envelope({ attestation: { id: 'attestation_ui' } }, 201);
    if (url.endsWith('/parse')) return envelope({ operation_id: 'operation_parser_ui', resource_id: 'parser_run_ui', status: 'succeeded' }, 202);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('P7 Evidence workspace', () => {
  it('renders lineage and restricted content, then submits revision-bound attest and parse commands', async () => {
    render(<EvidencePage {...props} />);
    expect(await screen.findByText('result.json')).toBeVisible();
    expect(await screen.findByText('{"passed":true}')).toBeVisible();
    expect(screen.getByText('derived_from')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Attest current version' }));
    await waitFor(() => expect(calls.some((call) => call.url === `/api/v2/assets/${assetId}/attestations` && call.revision === '3' && call.body.version_id === versionId)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Parse' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/parse') && call.revision === '3' && call.body.format_key === 'json')).toBe(true));
    expect(await screen.findByText('parsed')).toBeVisible();
    expect(screen.getByText('d'.repeat(10))).toBeVisible();
  });
});
