import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gatewaySignature } from '../apps/gateway/server.mjs';

const root = process.cwd();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-gateway-probe-'));
const apiPort = await freePort();
const gatewayPort = await freePort();
const secret = 'p4-independent-gateway-secret-0001';
const children = [];

try {
  children.push(start(['apps/api/server.mjs'], {
    AIWS_CLEAN_HOME: home, AIWS_CLEAN_PORT: String(apiPort), AIWS_CLEAN_VAULT_KEY: 'p4-gateway-probe-vault-key',
    AIWS_CLEAN_MCP_PEPPER: 'p4-gateway-probe-mcp-pepper-0001', AIWS_GATEWAY_SECRET: secret,
    AIWS_GATEWAY_ID: 'p4-independent-gateway', AIWS_CLEAN_BUILD: 'v3-clean-p4-gateway-probe'
  }));
  await waitFor(`http://127.0.0.1:${apiPort}/readyz`);
  children.push(start(['apps/gateway/server.mjs'], {
    AIWS_GATEWAY_PORT: String(gatewayPort), AIWS_GATEWAY_API_URL: `http://127.0.0.1:${apiPort}`,
    AIWS_GATEWAY_SECRET: secret, AIWS_GATEWAY_ID: 'p4-independent-gateway'
  }));
  await waitFor(`http://127.0.0.1:${gatewayPort}/readyz`);

  const setup = await request(`http://127.0.0.1:${apiPort}/api/v2/setup`, {
    method: 'POST', headers: mutationHeaders('p4-gateway-probe-setup', 0),
    body: JSON.stringify({ display_name: 'P4 Gateway Probe', team_name: 'P4 Gateway Probe' })
  });
  assert(setup.status === 201, `setup:${setup.status}`);
  const cookie = String(setup.headers.get('set-cookie') || '').split(';')[0];
  assert(cookie.startsWith('aiws_session='), 'setup_cookie');
  const projectResponse = await request(`http://127.0.0.1:${apiPort}/api/v2/projects`, {
    method: 'POST', headers: { ...mutationHeaders('p4-gateway-probe-project', 0), cookie }, body: JSON.stringify({ name: 'Gateway Probe Project' })
  });
  assert(projectResponse.status === 201, `project:${projectResponse.status}`);
  const project = projectResponse.body.data.project;
  const clientResponse = await request(`http://127.0.0.1:${apiPort}/api/v2/mcp/clients`, {
    method: 'POST', headers: { ...mutationHeaders('p4-gateway-probe-client', 0), cookie },
    body: JSON.stringify({ name: 'Gateway probe', transport: 'http', ttl_seconds: 3600, scope: { project_ids: [project.id], tools: ['context_map'] } })
  });
  assert(clientResponse.status === 201 && clientResponse.body.data.token, `client:${clientResponse.status}`);
  const forwardingBody = { name: 'context_map', arguments: { project_id: project.id }, mcp_token: clientResponse.body.data.token };
  const forwarded = await request(`http://127.0.0.1:${gatewayPort}/api/v2/gateway/forward`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forwardingBody)
  });
  assert(forwarded.status === 200, `forward:${forwarded.status}`);
  assert(forwarded.body.data.result.command_id === 'context.map', 'forward_command');
  const receiptId = forwarded.body.data.receipt.id;
  const receipt = await request(`http://127.0.0.1:${apiPort}/api/v2/gateway/receipts/${receiptId}`, { headers: { cookie } });
  assert(receipt.status === 200 && receipt.body.data.decision === 'accepted', `receipt:${receipt.status}`);
  assert(!JSON.stringify(receipt.body).includes(clientResponse.body.data.token), 'receipt_token_redaction');

  const replayBody = { name: 'context_map', arguments: { project_id: project.id }, mcp_token: clientResponse.body.data.token };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'p4-independent-replay-nonce';
  const signature = gatewaySignature({ secret, timestamp, nonce, body: replayBody });
  const replayHeaders = {
    'content-type': 'application/json', 'X-AIWS-Gateway-Id': 'p4-independent-gateway',
    'X-AIWS-Gateway-Timestamp': timestamp, 'X-AIWS-Gateway-Nonce': nonce, 'X-AIWS-Gateway-Signature': signature
  };
  const accepted = await request(`http://127.0.0.1:${apiPort}/api/v2/gateway/forward`, { method: 'POST', headers: replayHeaders, body: JSON.stringify(replayBody) });
  const replayed = await request(`http://127.0.0.1:${apiPort}/api/v2/gateway/forward`, { method: 'POST', headers: replayHeaders, body: JSON.stringify(replayBody) });
  assert(accepted.status === 200 && replayed.status === 409 && replayed.body.error.code === 'gateway_replay', 'nonce_replay');

  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3-clean.p4-gateway-probe.v1', status: 'passed',
    boundaries: ['independent-http-process', 'signed-forward', 'mcp-client-scope', 'nonce-replay', 'receipt-redaction'],
    api_user_version: 4, gateway_health: 'ready', command_id: 'context.map', receipt_decision: receipt.body.data.decision,
    replay_error: replayed.body.error.code
  }, null, 2)}\n`);
} finally {
  for (const child of children.reverse()) await stop(child);
  fs.rmSync(home, { recursive: true, force: true });
}

function mutationHeaders(key, revision) { return { 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Expected-Revision': String(revision) }; }
async function request(url, options = {}) { const response = await fetch(url, options); return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) }; }
function assert(value, label) { if (!value) throw new Error(`p4_gateway_probe_failed:${label}`); }
function start(args, env) { return spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
async function waitFor(url) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`p4_gateway_probe_startup_timeout:${url}`); }
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function stop(child) { if (!child || child.exitCode != null) return; child.kill(); await new Promise((resolve) => { const timer = setTimeout(resolve, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); if (child.exitCode == null && process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await new Promise((resolve) => killer.once('exit', resolve)); } }
