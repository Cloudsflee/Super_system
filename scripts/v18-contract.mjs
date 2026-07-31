import { isMain, runCommand } from './v175-lib.mjs';

export const V18_CONTRACT_TESTS = Object.freeze([
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
]);

export async function runV18Contract() {
  for (const file of V18_CONTRACT_TESTS) {
    const result = await runCommand(['node', file], { timeout: 240_000, inherit: true });
    if (result.status !== 0) return result.status || 1;
  }
  console.log(`V1.8 MCP contract passed (${V18_CONTRACT_TESTS.length} files)`);
  return 0;
}

if (isMain(import.meta.url)) {
  const status = await runV18Contract();
  if (status !== 0) process.exit(status);
}
