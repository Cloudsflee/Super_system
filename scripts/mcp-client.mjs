#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = String(process.env.AIWS_MCP_TOKEN || ''),
  url = new URL(process.env.AIWS_MCP_URL || 'http://127.0.0.1:4317/api/mcp');
if (!token) {
  process.stderr.write('AIWS_MCP_TOKEN is required\n');
  process.exit(2);
}
const client = new Client({ name: 'aiws-developer-client', version: '2.0.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});

try {
  await client.connect(transport);
  const [command = 'list-tools', ...args] = process.argv.slice(2);
  let result;
  if (command === 'list-tools') result = await client.listTools(args[0] ? { cursor: args[0] } : undefined);
  else if (command === 'list-resources') result = await client.listResources(args[0] ? { cursor: args[0] } : undefined);
  else if (command === 'list-resource-templates')
    result = await client.listResourceTemplates(args[0] ? { cursor: args[0] } : undefined);
  else if (command === 'read') result = await client.readResource({ uri: required(args[0], 'resource URI') });
  else if (command === 'call')
    result = await client.callTool({ name: required(args[0], 'tool name'), arguments: parseJson(args[1] || '{}') });
  else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function parseJson(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('tool arguments must be a JSON object');
  return parsed;
}
