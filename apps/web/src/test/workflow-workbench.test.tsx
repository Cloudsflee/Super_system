import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkflowEditor } from '../features/project/WorkflowEditor';
import { newWorkflowNode, validateWorkflowGraph, type WorkflowEditorNode } from '../features/project/workflowEditorModel';

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
