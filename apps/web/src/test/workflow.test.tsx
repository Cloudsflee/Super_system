import { useState } from 'react';
import { WorkflowEditor, newWorkflowNode, validateWorkflowGraph, type WorkflowEditorNode } from '../features/project/WorkflowCanvas';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const project = {
  id: 'prj_test', name: 'Test project', description: '', status: 'active', revision: 1, updated_at: '2026-08-06T00:00:00.000Z',
  brief: { project_id: 'prj_test', revision: 1, content_hash: 'a'.repeat(64), content: { objective: 'Test objective', acceptance: [] }, created_at: '2026-08-06T00:00:00.000Z' },
  workflow: { project_id: 'prj_test', revision: 1, name: 'Test workflow', graph_hash: 'b'.repeat(64), created_at: '2026-08-06T00:00:00.000Z', tasks: [
    { id: 'inspect', title: 'Inspect repository', level: 1, deps: [], mode: 'read', inputs: [], outputs: ['analysis.md'] },
    { id: 'write', title: 'Write change', level: 2, deps: ['inspect'], mode: 'write', inputs: ['analysis.md'], outputs: ['change.diff'] }
  ] }
};

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ request_id: 'req_clean_workflow', data, meta: { api_version: '2' } }), {
    status, headers: { 'content-type': 'application/json' }
  });
}

beforeEach(() => {
  location.hash = '/workflow';
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v2/setup')) return envelope({ needs_setup: false, actor_count: 1 });
    if (url.endsWith('/api/v2/projects') && (options?.method || 'GET') === 'GET') return envelope({ projects: [{ ...project, brief: undefined, workflow: undefined }] });
    if (url.endsWith('/api/v2/projects/prj_test')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: null });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/repository-connections')) return envelope({ connections: [] });
    if (url.endsWith('/repository-lines')) return envelope({ lines: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: project.workflow });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/outcome-requirements')) return envelope({ requirements: [] });
    return envelope({});
  }));
});

describe('workflow inspector', () => {
  it('loads the Clean workflow surface and keeps its graph controls on v2', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Test project' });
    expect(screen.getByText('工作流草稿')).toBeVisible();
    fireEvent.click(screen.getByText('高级 JSON 编辑'));
    const graph = screen.getByLabelText('图谱 JSON');
    fireEvent.change(graph, { target: { value: '{"nodes":[{"id":"inspect"}]}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
    expect(screen.getByText(/Task 需要有效 execution/)).toBeVisible();
    await waitFor(() => expect(screen.getByDisplayValue('{"nodes":[{"id":"inspect"}]}')).toBeVisible());
  });
});

const task = (): WorkflowEditorNode => ({ id: 'inspect', kind: 'task', title: 'Inspect repository', depends_on: [], parent_id: 'group', config: { goal: 'Inspect', execution: { mode: 'read', argv: ['node', '-e', 'console.log("two words")'], cwd_role: 'task', input_paths: ['README.md'], output_paths: [], deadline_seconds: 60, resource_profile: 'light', capabilities: ['network:none'], check_ids: ['node_test'] } }, contract: { acceptance: ['node_test'] } });
const graph = (): { name: string; nodes: WorkflowEditorNode[] } => ({ name: 'Graph', nodes: [{ id: 'group', kind: 'workstream', title: 'Group', config: {} }, task()] });
function Editor() { const [source, setSource] = useState(JSON.stringify(graph())); return <><WorkflowEditor source={source} onChange={setSource} busy={false} onContext={() => {}} onReplan={() => {}} replanDisabled={false} initialView="canvas" /><output data-testid="saved-graph">{source}</output></>; }
describe('Workflow structured editing', () => {
  it('selects canvas/list nodes, preserves argument boundaries and edits the same JSON draft', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: /Inspect repository/ }));
    fireEvent.change(screen.getByLabelText('节点标题'), { target: { value: 'Inspect changed' } });
    fireEvent.change(screen.getByLabelText('命令参数（每行一个参数）'), { target: { value: 'node\n-e\nconsole.log("still two words")' } });
    fireEvent.click(screen.getByRole('tab', { name: '工作流组' }));
    fireEvent.click(screen.getByRole('button', { name: /Group/ }));
    expect(screen.getByRole('button', { name: '删除节点' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: '节点' }));
    fireEvent.click(screen.getByRole('button', { name: /Inspect changed/ }));
    fireEvent.click(screen.getByText('高级 JSON 编辑'));
    const stored = JSON.parse((screen.getByLabelText('图谱 JSON') as HTMLTextAreaElement).value);
    expect(stored.nodes[1].config.execution.argv).toEqual(['node', '-e', 'console.log("still two words")']);
    expect(stored.nodes[1].title).toBe('Inspect changed');
    expect(validateWorkflowGraph(stored)).toEqual([]);
  });
  it('adds valid defaults and removes dependency references atomically', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: '新增 Task' }));
    fireEvent.change(screen.getByLabelText('依赖 ID（每行一个）'), { target: { value: 'inspect' } });
    fireEvent.click(screen.getByRole('tab', { name: '节点' }));
    fireEvent.click(screen.getByRole('button', { name: /Inspect repository/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除节点' }));
    const stored = JSON.parse(screen.getByTestId('saved-graph').textContent!);
    expect(stored.nodes.find((node: WorkflowEditorNode) => node.id === 'task_1').depends_on).toEqual([]);
    expect(validateWorkflowGraph(stored)).toEqual([]);
    expect(newWorkflowNode('task', [newWorkflowNode('task', [])]).id).toBe('task_2');
  });
  it.each([
    ['duplicate', (nodes: WorkflowEditorNode[]) => nodes.push({ ...nodes[1] })],
    ['empty ID', (nodes: WorkflowEditorNode[]) => { nodes[1].id = ''; }],
    ['orphan dependency', (nodes: WorkflowEditorNode[]) => { nodes[1].depends_on = ['missing']; }],
    ['self dependency', (nodes: WorkflowEditorNode[]) => { nodes[1].depends_on = ['inspect']; }],
    ['cycle', (nodes: WorkflowEditorNode[]) => { nodes[0].depends_on = ['inspect']; nodes[1].depends_on = ['group']; }],
    ['parent', (nodes: WorkflowEditorNode[]) => { nodes[1].parent_id = 'missing'; }],
    ['command', (nodes: WorkflowEditorNode[]) => { nodes[1].config!.execution!.argv = ['powershell']; }],
    ['acceptance', (nodes: WorkflowEditorNode[]) => { nodes[1].contract!.acceptance = ['git_diff_check']; }],
    ['unknown check', (nodes: WorkflowEditorNode[]) => { nodes[1].config!.execution!.check_ids = ['unknown']; }],
    ['network', (nodes: WorkflowEditorNode[]) => { nodes[1].config!.execution!.capabilities = []; }],
    ['deadline', (nodes: WorkflowEditorNode[]) => { nodes[1].config!.execution!.deadline_seconds = 901; }],
    ['missing execution', (nodes: WorkflowEditorNode[]) => { nodes[1].config = {}; }]
  ])('blocks %s without repairing away the invalid entry', (_, change) => { const value = graph(); change(value.nodes); expect(validateWorkflowGraph(value).length).toBeGreaterThan(0); });
  it.each(['../outside', '/etc/file', 'C:\\secret', '\\\\host\\file', 'https://host/file', './README.md', 'dir//file'])('blocks invalid path %s', path => {
    const value = graph(); value.nodes[1].config!.execution!.input_paths = [path]; expect(validateWorkflowGraph(value).some(issue => issue.path.endsWith('.input_paths'))).toBe(true);
  });
});
