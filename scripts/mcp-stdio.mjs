#!/usr/bin/env node
/* JSON-RPC stdio bridge.  It intentionally keeps the token in process memory
 * and forwards one request at a time to the loopback Streamable HTTP endpoint. */
import readline from 'node:readline';

const endpoint = String(process.env.AIWS_MCP_URL || 'http://127.0.0.1:4317/api/v1/mcp');
const token = String(process.env.AIWS_MCP_TOKEN || '');
let parsedEndpoint;
try { parsedEndpoint = new URL(endpoint); } catch { throw new Error('mcp_stdio_endpoint_invalid'); }
if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsedEndpoint.hostname)) throw new Error('mcp_stdio_endpoint_invalid');
if (!token) throw new Error('mcp_stdio_token_required');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = '';
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-aiws-mcp-token': token, 'mcp-transport': 'stdio', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify(request)
    });
    sessionId = response.headers.get('mcp-session-id') || sessionId;
    const body = await response.json().catch(() => ({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32603, message: 'Invalid MCP response' } }));
    process.stdout.write(`${JSON.stringify(body)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32603, message: String(error?.message || 'MCP transport error').slice(0, 200) } })}\n`);
  }
}
