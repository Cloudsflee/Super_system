import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {
  callOperation,
  callTool,
  createMcpTestFixture,
  resultData,
  seedHostCodexProfile
} from './mcp-test-helpers.mjs';

const options = parseArgs(process.argv.slice(2));
const durationMs = options.minutes * 60_000;
const fixture = await createMcpTestFixture('aiws-v18-soak-', {
  nodeArgs: ['--expose-gc'],
  env: { AIWS_CODEX_BIN: process.execPath, NODE_REPL_HISTORY: '' },
  operator: { concurrent_limit: 8, rate_limit_per_minute: 6000 },
  seed: seedHostCodexProfile
});
let connection;
const terminalIds = new Set();
const startedAt = Date.now();
let baselineHeap = null;

try {
  connection = await fixture.connect(fixture.operator, 'v18-soak');
  const created = resultData(
    await callOperation(connection.client, 'aiws.projects.post.projects', {
      body: { title: 'V1.8 MCP soak', goal: 'Exercise repeated runtime cleanup' }
    })
  );
  await callOperation(connection.client, 'aiws.projects.put.projects.by-id.intake', {
    params: { id: created.project.id },
    body: {
      mode: 'brainstorm',
      answers: {
        goal: 'Exercise repeated runtime cleanup',
        features: ['Assist', 'Terminal'],
        acceptance_criteria: ['No residue']
      }
    }
  });
  await callOperation(connection.client, 'aiws.projects.post.projects.by-id.onboarding.confirm', {
    params: { id: created.project.id },
    body: {}
  });

  for (let round = 0; round < options.rounds; round += 1) {
    const session = resultData(
      await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions', {
        body: {
          project_id: created.project.id,
          scope_type: 'project',
          scope_id: created.project.id,
          title: `Soak round ${round + 1}`
        }
      })
    );
    const turn = await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
      params: { id: session.id },
      body: {
        adapter: 'test',
        content: `Cancel round ${round + 1}`,
        test_response: { delay_ms: 1200, message: 'late' }
      }
    });
    await callTool(connection.client, 'aiws_operations', {
      action: 'cancel',
      operation_id: turn.handle.id,
      reason: `soak_round_${round + 1}`
    });
    const turnDone = await callTool(connection.client, 'aiws_operations', {
      action: 'wait',
      operation_id: turn.handle.id,
      timeout_ms: 5000,
      poll_ms: 50
    });
    assert.equal(turnDone.data.operation.terminal, true);
    await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.archive', {
      params: { id: session.id },
      body: {}
    });
    const terminalSession = resultData(
      await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions', {
        body: {
          project_id: created.project.id,
          scope_type: 'project',
          scope_id: created.project.id,
          title: `Soak terminal ${round + 1}`
        }
      })
    );

    const terminal = resultData(
      await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions', {
        body: {
          project_id: created.project.id,
          assist_session_id: terminalSession.id,
          profile_id: 'cdx_v18_test_host',
          runtime: 'host_dev',
          cols: 80,
          rows: 20
        }
      })
    );
    terminalIds.add(terminal.id);
    await callTool(connection.client, 'aiws_terminal', {
      action: 'aiws.terminal.input',
      arguments: { session_id: terminal.id, data: `console.log('SOAK:${round + 1}');process.exit(0)\r` }
    });
    const terminalDone = await callTool(connection.client, 'aiws_operations', {
      action: 'wait',
      operation_id: terminal.id,
      timeout_ms: 10_000,
      poll_ms: 100
    });
    assert.equal(terminalDone.data.operation.status, 'exited');
    await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.review.rollback', {
      params: { id: terminal.id },
      body: {}
    });
    terminalIds.delete(terminal.id);
    await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.archive', {
      params: { id: terminalSession.id },
      body: {}
    });

    const health = resultData(await callOperation(connection.client, 'aiws.system.get.health', { query: { gc: '1' } }));
    if (round === 0) baselineHeap = health.runtime.heap_used_bytes;
    if ((round + 1) % 5 === 0 && round + 1 < options.rounds) {
      await connection.close();
      connection = null;
      await fixture.restartServer();
      connection = await fixture.connect(fixture.operator, `v18-soak-restart-${round + 1}`);
    }

    const targetElapsed = durationMs * ((round + 1) / options.rounds);
    const remaining = targetElapsed - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  await callOperation(connection.client, 'aiws.projects.post.projects.by-id.trash', {
    params: { id: created.project.id },
    body: {}
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const finalHealth = resultData(
    await callOperation(connection.client, 'aiws.system.get.health', { query: { gc: '1' } })
  );
  assert.equal(finalHealth.runtime.terminal.active_count, 0);
  assert.equal(finalHealth.runtime.terminal.starting_count, 0);
  const heapGrowth = baselineHeap > 0 ? (finalHealth.runtime.heap_used_bytes - baselineHeap) / baselineHeap : 0;
  assert.equal(
    heapGrowth <= 0.2,
    true,
    `heap grew ${(heapGrowth * 100).toFixed(2)}% (${baselineHeap} -> ${finalHealth.runtime.heap_used_bytes})`
  );
  const state = await fixture.stateApi.readState();
  assert.equal(
    state.terminal_sessions.some((item) => ['ready', 'starting', 'running', 'connected'].includes(item.status)),
    false
  );
  assert.equal(
    state.assist_turns.some((item) => ['queued', 'preparing', 'running', 'stopping'].includes(item.status)),
    false
  );
  fixture.assertMcpOnlyHttp();

  await connection.close();
  connection = null;
  await fixture.close();
  assert.equal(fs.existsSync(fixture.root), false);
  assert.equal(await portListening(fixture.port), false);
  console.log(
    `V1.8 MCP soak passed (${options.rounds} rounds, ${options.minutes} minutes, heap growth ${(heapGrowth * 100).toFixed(2)}%)`
  );
} finally {
  if (connection) {
    for (const id of terminalIds)
      await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.stop', {
        params: { id },
        body: {}
      }).catch(() => undefined);
    await connection.close();
  }
  if (fs.existsSync(fixture.root)) await fixture.close();
}

function parseArgs(argv) {
  let minutes = 120,
    rounds = 20;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--minutes') minutes = Number(argv[++index]);
    else if (argv[index] === '--rounds') rounds = Number(argv[++index]);
    else throw new Error(`unknown_soak_option:${argv[index]}`);
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180) throw new Error('soak_minutes_invalid');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('soak_rounds_invalid');
  return { minutes, rounds };
}
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
