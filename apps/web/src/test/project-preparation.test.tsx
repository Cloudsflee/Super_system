import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparationPanel, pollWorkspaceUntil, SourceSelector, ReadinessSummary } from '../features/projects/preparation';

beforeEach(() => sessionStorage.clear());

function envelope(data: unknown, status = 200) { return new Response(JSON.stringify({ request_id: 'preparation', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } }); }

function scenario() {
  const connection = { id: 'connection_selected', provider: 'local', source_kind: 'local', source_revision: 'commit-right', source_hash: 'a'.repeat(64), status: 'ready', revision: 1 };
  const line = { id: 'line_selected', line_kind: 'external_readonly', status: 'ready', source_revision: connection.source_revision, source_hash: connection.source_hash, revision: 1, updated_at: '2026-09-19T03:00:00Z' };
  let workspace = { id: 'workspace_selected', line_id: line.id, status: 'ready', relative_path: 'projects/project_prepare/workspace', revision: 2, updated_at: '2026-09-19T04:00:00Z', error_code: '' };
  const mutations: Array<{ url: string; body: Record<string, unknown>; revision: string | null }> = [];
  const fileRequests: URL[] = [];
  let filePage = (offset: number) => ({ files: [file('file_a'), file('file_b')], next_cursor: null as number | null });
  let workspaceReads = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://fixture');
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      mutations.push({ url: url.pathname, body, revision: new Headers(options.headers).get('X-Expected-Revision') });
      if (url.pathname.endsWith('/repository-connections')) return envelope({ connection }, 201);
      if (url.pathname.endsWith('/repository-workspaces')) { workspace = { ...workspace, status: 'requested', revision: 1 }; return envelope({ workspace }, 202); }
      if (url.pathname.endsWith('/refresh')) { workspace = { ...workspace, status: 'provisioning', revision: workspace.revision + 1, error_code: '' }; return envelope({ workspace }, 202); }
      throw new Error(`Unexpected mutation ${url}`);
    }
    if (url.pathname.endsWith('/repository-connections')) return envelope({ connections: [{ ...connection, id: 'connection_wrong', source_revision: 'wrong', source_hash: 'b'.repeat(64) }, connection] });
    if (url.pathname.endsWith('/repository-lines')) return envelope({ lines: [
      { ...line, id: 'wrong_hash', source_hash: 'b'.repeat(64), updated_at: '2099' },
      { ...line, id: 'wrong_revision', source_revision: 'wrong', updated_at: '2099' },
      { ...line, id: 'wrong_kind', line_kind: 'development', updated_at: '2099' },
      { ...line, id: 'older_match', updated_at: '2026-01-01' }, line
    ] });
    if (url.pathname.endsWith('/repository-workspaces')) { workspaceReads += 1; return envelope({ workspaces: [
      { ...workspace, id: 'workspace_wrong', line_id: 'wrong_hash', updated_at: '2099' },
      { ...workspace, id: 'workspace_older', updated_at: '2026-01-01' }, workspace
    ] }); }
    if (url.pathname.endsWith('/context/packs')) return envelope({ packs: [] });
    if (url.pathname.endsWith('/profiles')) return envelope({ profiles: [] });
    if (url.pathname.endsWith('/files')) { fileRequests.push(url); expect(url.searchParams.get('workspace_id')).toBe(workspace.id); expect(url.searchParams.get('limit')).toBe('500'); return envelope(filePage(Number(url.searchParams.get('offset')))); }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { mutations, fileRequests, connection, line, get workspace() { return workspace; }, get workspaceReads() { return workspaceReads; }, changeWorkspace: (values: Partial<typeof workspace>) => { workspace = { ...workspace, ...values }; }, pages: (fn: typeof filePage) => { filePage = fn; } };
}

function file(id: string) { return { id, path: `${id}.txt`, media_type: 'text/plain', byte_length: 20, content_sha256: 'a'.repeat(64), status: 'current', revision: 1 }; }
async function chooseSource() {
  await screen.findByRole('option', { name: 'commit-right' });
  fireEvent.change(screen.getByLabelText('仓库连接'), { target: { value: 'connection_selected' } });
  await waitFor(() => expect(sessionStorage.getItem('aiws:preparation:project_prepare:line')).toBe('line_selected'));
}

describe('project preparation controls', () => {
  it('offers local and GitHub sources with an editable branch', () => {
    render(<SourceSelector kind="github" onKindChange={vi.fn()} locator="ORG/REPO" branch="trunk" onLocatorChange={vi.fn()} onBranchChange={vi.fn()} profiles={[{ id: 'profile', provider: 'github', status: 'available' }]} onDiscover={vi.fn()} repositories={[{ id: 1, full_name: 'ORG/REPO', default_branch: 'trunk' }]} selectedRepository="ORG/REPO" onRepositoryChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /本机 Git/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /GitHub/ })).toBeTruthy();
    expect(screen.getByLabelText('仓库分支')).toHaveValue('trunk');
  });

  it('exposes missing preparation steps as direct actions', () => {
    const open = vi.fn();
    render(<ReadinessSummary ready={false} missing={['source', 'pack']} onOpen={open} />);
    screen.getByRole('button', { name: 'source' }).click();
    expect(open).toHaveBeenCalledWith('source');
  });
});

it('preserves remembered selections through initial loading and matches current fingerprint, line kind and update time', async () => {
  scenario();
  sessionStorage.setItem('aiws:preparation:project_prepare:connection', 'connection_selected');
  render(<PreparationPanel projectId="project_prepare" />);
  await screen.findByLabelText('仓库连接');
  await waitFor(() => expect(sessionStorage.getItem('aiws:preparation:project_prepare:workspace')).toBe('workspace_selected'));
  expect(screen.getByLabelText('仓库连接')).toHaveValue('connection_selected');
  expect(sessionStorage.getItem('aiws:preparation:project_prepare:line')).toBe('line_selected');
  fireEvent.click(screen.getByRole('button', { name: 'context' }));
  fireEvent.click(screen.getByRole('button', { name: '返回工作区' }));
  expect(screen.getByLabelText('准备分支')).toHaveValue('line_selected');
  expect(screen.getByLabelText('托管工作区')).toHaveValue('workspace_selected');
});

it.each(['requested', 'provisioning'])('keeps %s workspaces in the Workspace step until the selected workspace is ready', async status => {
  const state = scenario();
  const waits: Array<() => void> = [];
  const sleep = vi.fn((_milliseconds: number) => new Promise<void>(resolve => waits.push(resolve)));
  render(<PreparationPanel projectId="project_prepare" sleep={sleep} />);
  await chooseSource();
  fireEvent.click(screen.getByRole('button', { name: 'context' }));
  fireEvent.click(screen.getByRole('button', { name: '返回工作区' }));
  fireEvent.click(screen.getByRole('button', { name: '创建托管工作区' }));
  await waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('preparation-context')).toBeNull();
  state.changeWorkspace({ status });
  await act(async () => { waits.shift()?.(); });
  await waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('preparation-workspace-status')).toHaveTextContent(status);
  expect(state.mutations[0].body.line_id).toBe('line_selected');
  state.changeWorkspace({ status: 'ready', revision: 3 });
  await act(async () => { waits.shift()?.(); });
  await screen.findByTestId('preparation-context');
  expect(sleep.mock.calls.every(args => args[0] === 1000)).toBe(true);
});

it('shows orphan errors with retry and source navigation, then refreshes using the selected workspace revision', async () => {
  const state = scenario();
  const sleep = vi.fn(async () => { state.changeWorkspace({ status: 'orphaned', error_code: 'source_drift', revision: 4 }); });
  render(<PreparationPanel projectId="project_prepare" sleep={sleep} />);
  await chooseSource();
  fireEvent.click(screen.getByRole('button', { name: 'context' }));
  fireEvent.click(screen.getByRole('button', { name: '返回工作区' }));
  fireEvent.click(screen.getByRole('button', { name: '创建托管工作区' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('source_drift');
  expect(screen.getByTestId('preparation-workspace-status')).toHaveTextContent('orphaned');
  expect(screen.getAllByRole('button', { name: '返回来源' }).length).toBeGreaterThan(0);
  sleep.mockImplementation(async () => { state.changeWorkspace({ status: 'ready', error_code: '', revision: 6 }); });
  fireEvent.click(screen.getByRole('button', { name: '重试物化' }));
  await screen.findByTestId('preparation-context');
  expect(state.mutations.at(-1)).toMatchObject({ url: '/api/v2/projects/project_prepare/repository-workspaces/workspace_selected/refresh', revision: '4' });
});

it('enforces 120 one-second polls and accepts readiness on the final poll', async () => {
  const initial = { id: 'selected', line_id: 'line', status: 'requested', relative_path: 'workspace', revision: 1 };
  const sleep = vi.fn(async (_milliseconds: number) => {});
  const latest = vi.fn(async () => ({ ...initial, status: 'provisioning' }));
  await expect(pollWorkspaceUntil(initial.id, initial, latest, { sleep })).rejects.toThrow('workspace_provisioning_timeout');
  expect(latest).toHaveBeenCalledTimes(120);
  expect(sleep).toHaveBeenCalledTimes(120);
  expect(sleep.mock.calls.every(([ms]) => ms === 1000)).toBe(true);
  let calls = 0;
  await expect(pollWorkspaceUntil(initial.id, initial, async () => ({ ...initial, status: ++calls === 120 ? 'ready' : 'provisioning' }), { sleep })).resolves.toMatchObject({ status: 'ready' });
  expect(calls).toBe(120);
});

it('loads Files with limit 500 and follows next_cursor before clearing invalid selected IDs on reload', async () => {
  const state = scenario();
  state.pages(offset => offset === 0 ? { files: [file('missing'), file('stale'), file('outside'), file('valid')], next_cursor: 700 } : { files: [file('last')], next_cursor: null });
  render(<PreparationPanel projectId="project_prepare" />);
  await chooseSource();
  fireEvent.click(screen.getByRole('button', { name: 'context' }));
  fireEvent.click(screen.getByRole('button', { name: '加载文件' }));
  await screen.findByText('last.txt');
  for (const name of ['missing', 'stale', 'outside', 'valid']) fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name + '[.]txt') }));
  expect(state.fileRequests.map(url => url.searchParams.get('offset'))).toEqual(['0', '700']);
  state.pages(() => ({ files: [{ ...file('stale'), status: 'deleted' }, { ...file('outside'), path: '../outside.txt' }, file('valid')], next_cursor: null }));
  fireEvent.click(screen.getByRole('button', { name: '加载文件' }));
  await screen.findByText('../outside.txt');
  expect(screen.queryByText('missing.txt')).toBeNull();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /stale[.]txt/ })).not.toBeChecked());
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /outside[.]txt/ })).not.toBeChecked());
  expect(screen.getByRole('checkbox', { name: /outside[.]txt/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /valid[.]txt/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '继续封存' }));
  expect(screen.getByText(/1 项/)).toBeVisible();
});

it('stops Files paging at 10000 even when the API offers another page', async () => {
  const state = scenario();
  state.pages(offset => ({ files: Array.from({ length: 500 }, (_, index) => file(`row_${offset + index}`)), next_cursor: offset + 500 }));
  render(<PreparationPanel projectId="project_prepare" />);
  await chooseSource();
  fireEvent.click(screen.getByRole('button', { name: 'context' }));
  fireEvent.click(screen.getByRole('button', { name: '加载文件' }));
  await screen.findByText('row_9999.txt', {}, { timeout: 10000 });
  expect(state.fileRequests).toHaveLength(20);
  expect(state.fileRequests.at(-1)?.searchParams.get('offset')).toBe('9500');
  expect(screen.queryByText('row_10000.txt')).toBeNull();
}, 15000);
