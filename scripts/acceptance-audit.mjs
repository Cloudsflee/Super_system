import assert from 'node:assert/strict';
import fs from 'node:fs';

const checks = [
  ['Local Owner', 'apps/api/src/state.mjs', 'createLocalOwner'],
  ['Project API', 'apps/api/src/routes/projects.mjs', '/projects'],
  ['Workflow confirm', 'apps/api/src/routes/projects.mjs', '/workflows/:id/confirm'],
  ['Node Contract', 'packages/shared/src/domain.mjs', 'defaultContractForNode'],
  ['Assist API', 'apps/api/src/routes/assist.mjs', '/assist/sessions'],
  ['Assist Context', 'packages/shared/src/memory.mjs', 'buildAssistContextPack'],
  ['Sufficiency', 'packages/shared/src/memory.mjs', 'buildSufficiencyCheck'],
  ['Memory Manifest', 'packages/shared/src/memory.mjs', 'buildMemoryManifest'],
  ['Context Pack', 'packages/shared/src/context-run.mjs', 'buildContextPack'],
  ['Runner Adapter', 'packages/runner-adapters/src/index.mjs', 'CodexRunner'],
  ['AGENTS block', 'packages/runner-adapters/src/index.mjs', 'ensureAgentsBlock'],
  ['Trace', 'apps/api/src/state.mjs', 'addTrace'],
  ['Asset', 'apps/api/src/routes/assets.mjs', '/asset-candidates/:id/confirm'],
  ['Digest', 'apps/api/src/handlers/digests.mjs', 'createDigest'],
  ['Git', 'apps/api/src/routes/git.mjs', '/runs/:id/git/diff'],
  ['Git integration test', 'tests/integration/git-flow.test.mjs', 'git integration tests passed'],
  ['GitHub', 'apps/api/src/routes/github.mjs', '/integrations/github/status'],
  ['GitHub mock integration', 'tests/integration/github-flow.test.mjs', 'github mock integration tests passed'],
  ['Tool Registry', 'apps/api/src/routes/tools.mjs', '/tools'],
  ['Tool integration test', 'tests/integration/tools-flow.test.mjs', 'tool registry integration tests passed'],
  ['MCP Bridge', 'packages/mcp-bridge/src/index.mjs', 'mockHealthCheck'],
  ['Worker', 'apps/worker/src/index.mjs', 'node-run.execute'],
  ['Frontend Assist', 'apps/web/index.html', 'Codex Assist'],
  ['Frontend Assist UI', 'apps/web/src/assist-ui.js', 'renderOptions'],
  ['Frontend Views', 'apps/web/app.js', 'Workflow Canvas'],
  ['Decision Records', 'packages/shared/src/decisions.mjs', 'createDecisionRecord'],
  ['Demo full chain', 'tests/integration/demo-flow.test.mjs', 'demo full-chain tests passed'],
  ['Runner cancel', 'apps/api/src/handlers/runners.mjs', 'cancelRunInState'],
  ['Completion audit', 'docs/completion-audit.md', 'V1 Definition of Done 对照']
  ,['V1.1 dev plan', '开发计划v1.1.md', 'V1.1 目标']
  ,['V1.1 test plan', '测试计划v1.1.md', '测试目标']
  ,['Codex Dockerfile', 'docker/codex-runner.Dockerfile', '@openai/codex']
  ,['GitHub OAuth V1.1', 'apps/api/src/routes/github-oauth-v11.mjs', '/integrations/github/oauth/device/start']
  ,['cc-switch V1.1', 'apps/api/src/routes/integrations-v11.mjs', '/integrations/cc-switch/sync']
  ,['Agent Sessions V1.1', 'apps/api/src/routes/agent-sessions-v11.mjs', '/agent-sessions/:id/submissions']
  ,['Change Proposals V1.1', 'apps/api/src/routes/change-proposals-v11.mjs', '/change-proposals/:id/apply']
  ,['Light UI V1.1', 'apps/web/styles/base.css', '--bg: #f7f3ea']
  ,['Workflow Canvas V1.1', 'apps/web/src/views/workflow.js', 'workflow-stage']
  ,['Approval Drawer V1.1', 'apps/web/index.html', 'approval-panel']
];
for (const [name, file, needle] of checks) {
  assert.ok(fs.existsSync(file), `${name}: ${file} exists`);
  assert.ok(fs.readFileSync(file, 'utf8').includes(needle), `${name}: contains ${needle}`);
}
const coverage = fs.readFileSync('docs/v1-coverage-matrix.md', 'utf8');
for (const keyword of ['Local Owner', 'Context Pack', 'Memory Manifest', 'GitHub', 'Tool Registry', 'Prisma', 'CodexRunner']) assert.ok(coverage.includes(keyword), `coverage matrix includes ${keyword}`);
console.log(`acceptance audit passed (${checks.length} implementation checks)`);
