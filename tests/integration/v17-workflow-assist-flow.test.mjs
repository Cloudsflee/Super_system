import assert from 'node:assert/strict';
import { api, cleanup, createConfirmedProject, makeFixture, startApi } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4591),
  fixture = makeFixture('aiws-v17-workflow-assist-flow-');
const server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });

try {
  const created = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: 'Workflow Assist API',
    goal: 'Atomic graph proposals',
    workflowNodes: [
      { id: 'node-a', type: 'goal_definition', title: '目标', goal: '目标', dependency_ids: [] },
      { id: 'node-b', type: 'execution', title: '实现', goal: '实现', dependency_ids: ['node-a'] },
      { id: 'node-c', type: 'retrospective', title: '复盘', goal: '复盘', dependency_ids: ['node-b'] }
    ]
  });
  let bundle = await api(port, `/projects/${created.project.id}`),
    workflow = bundle.workflows[0];
  assert.equal(workflow.version, 1);
  const proposal = await api(
    port,
    `/workflows/${workflow.id}/graph-proposals`,
    'POST',
    {
      expected_revision: 1,
      operations: [
        {
          type: 'update_node',
          node_id: 'node-b',
          patch: { title: '方案分析成果', goal: '分析', outcome: '形成方案分析成果' }
        },
        add('node-d', '并行调研', ['node-a']),
        add('node-e', '并行验证', ['node-a']),
        add('node-f', '汇总', ['node-d', 'node-e']),
        add('node-g', '执行', ['node-f']),
        add('node-h', '审查', ['node-g'], 'retrospective'),
        { type: 'disconnect', node_id: 'node-c', dependency_id: 'node-b' },
        { type: 'connect', node_id: 'node-c', dependency_id: 'node-f' },
        { type: 'reorder_nodes', ids: ['node-a', 'node-b', 'node-d', 'node-e', 'node-f', 'node-c', 'node-g', 'node-h'] }
      ]
    },
    201
  );
  assert.equal(proposal.change_type, 'workflow_graph_patch');
  assert.equal(proposal.after_json.nodes.length, 8);
  bundle = await api(port, `/projects/${created.project.id}`);
  assert.equal(bundle.workflows[0].version, 1);
  assert.equal(bundle.nodes.length, 6, 'approval has not happened');
  await api(port, `/workflows/${workflow.id}/layout`, 'PUT', {
    nodes: [{ id: 'node-a', position: { x: 900, y: 700 } }]
  });
  await api(port, `/approvals/proposal/${proposal.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: proposal.revision,
    target_hash: proposal.target_hash
  });
  bundle = await api(port, `/projects/${created.project.id}`);
  assert.equal(bundle.workflows[0].version, 2);
  assert.equal(bundle.nodes.length, 16);
  assert.deepEqual(bundle.nodes.find((item) => item.id === 'node-a').position, { x: 900, y: 700 });
  assert.deepEqual(
    bundle.nodes.find((item) => item.id === 'node-d').dependencies.map((item) => item.node_id),
    ['node-a']
  );
  assert.deepEqual(
    bundle.nodes.find((item) => item.id === 'node-e').dependencies.map((item) => item.node_id),
    ['node-a']
  );
  assert.deepEqual(
    new Set(bundle.nodes.find((item) => item.id === 'node-f').dependencies.map((item) => item.node_id)),
    new Set(['node-d', 'node-e'])
  );

  const first = await api(
    port,
    `/workflows/${workflow.id}/graph-proposals`,
    'POST',
    {
      expected_revision: 2,
      operations: [{ type: 'update_node', node_id: 'node-g', patch: { title: '执行交付成果' } }]
    },
    201
  );
  const second = await api(
    port,
    `/workflows/${workflow.id}/graph-proposals`,
    'POST',
    {
      expected_revision: 2,
      operations: [{ type: 'update_node', node_id: 'node-h', patch: { title: '过期审查成果' } }]
    },
    201
  );
  await api(port, `/approvals/proposal/${first.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: first.revision,
    target_hash: first.target_hash
  });
  await api(
    port,
    `/approvals/proposal/${second.id}/decision`,
    'POST',
    { decision: 'approve_apply', revision: second.revision, target_hash: second.target_hash },
    409,
    'proposal_stale'
  );
  const proposals = await api(port, `/change-proposals?project_id=${created.project.id}`);
  assert.equal(proposals.find((item) => item.id === second.id).status, 'stale');
  bundle = await api(port, `/projects/${created.project.id}`);
  assert.equal(bundle.workflows[0].version, 3);
  assert.equal(bundle.nodes.find((item) => item.id === 'node-h').title, '审查成果');

  const legacy = await api(
    port,
    `/workflows/${workflow.id}/proposals`,
    'POST',
    { action: 'update_node', node_id: 'node-a', patch: { title: '兼容旧请求' } },
    201
  );
  await api(port, `/approvals/proposal/${legacy.id}/decision`, 'POST', {
    decision: 'approve_apply',
    revision: legacy.revision,
    target_hash: legacy.target_hash
  });
  bundle = await api(port, `/projects/${created.project.id}`);
  assert.equal(bundle.workflows[0].version, 4);
  assert.equal(bundle.nodes.find((item) => item.id === 'node-a').title, '兼容旧请求');

  console.log('V1.7 workflow Assist API integration tests passed');
} finally {
  await server.stop();
  cleanup(fixture.root);
}

function add(id, title, dependency_ids, type = 'execution') {
  const taskKind =
    type === 'research'
      ? 'research'
      : type === 'analysis'
        ? 'analysis'
        : type === 'retrospective'
          ? 'review'
          : 'manual';
  return {
    type: 'add_node',
    node: {
      id,
      role: 'workstream',
      title: `${title}成果`,
      goal: title,
      outcome: `${title}成果`,
      category: 'deliverable',
      acceptance_criteria: [`验收${title}成果`],
      boundary: { deliverable: id },
      dependency_ids,
      tasks: [
        {
          id: `${id}-task`,
          role: 'task',
          title: `${title}任务`,
          task_kind: taskKind,
          execution_mode: taskKind === 'manual' ? 'manual' : 'assist',
          dependency_ids: []
        }
      ]
    }
  };
}
