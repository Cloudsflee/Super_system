import { runCommand } from './v175-lib.mjs';

const tests = [
  'tests/v18/registry-contract.test.mjs',
  'tests/unit/v18-mcp-auth.test.mjs',
  'tests/unit/v18-mcp-gateway-auth.test.mjs',
  'tests/unit/v18-mcp-registry.test.mjs',
  'tests/unit/v18-codex-mcp-injection.test.mjs',
  'tests/unit/v18-release.test.mjs',
  'tests/integration/v18-mcp-http-flow.test.mjs',
  'tests/integration/v18-mcp-gateway-flow.test.mjs',
  'tests/integration/v18-mcp-stdio-flow.test.mjs',
  'tests/integration/v18-mcp-operations-flow.test.mjs',
  'tests/v18/security.test.mjs'
];
for (const file of tests) {
  const result = await runCommand(['node', file], { timeout: 240_000, inherit: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`V1.8 MCP contract passed (${tests.length} files)`);
