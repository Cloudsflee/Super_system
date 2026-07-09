import assert from 'node:assert/strict';
import fs from 'node:fs';

const required = [
  'apps/api/server.mjs', 'apps/worker/src/index.mjs', 'apps/web/index.html',
  'packages/shared/index.mjs', 'packages/runner-adapters/src/index.mjs',
  'packages/context-pack/src/index.mjs', 'packages/memory-policy/src/index.mjs',
  'packages/git-tools/src/index.mjs', 'packages/mcp-bridge/src/index.mjs',
  'prisma/schema.prisma', 'docker/compose.infra.yml'
];
for (const file of required) assert.ok(fs.existsSync(file), `${file} exists`);

const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
const coreModels = [
  'User', 'ConnectedAccount', 'CredentialRef', 'Project', 'Workspace',
  'Workflow', 'WorkflowNode', 'NodeContract', 'ContextPack',
  'ContextSufficiencyCheck', 'AssistSession', 'NodeRun', 'TraceEvent',
  'FileRef', 'Asset', 'AssetVersion', 'DecisionRecord', 'WorkspaceDigest',
  'CodeChange', 'ToolDefinition', 'HumanReview'
];
for (const model of coreModels) assert.ok(schema.includes(`model ${model}`), `schema contains ${model}`);
for (const mapped of ['users', 'projects', 'context_packs', 'node_runs', 'trace_events', 'assets', 'code_changes', 'tool_definitions']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps ${mapped}`);
console.log(`migration/schema check passed (${coreModels.length} core models)`);
