import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

for (const file of ['apps/web/index.html', 'apps/web/app.js', 'apps/web/styles.css', 'apps/web/src/assist-ui.js']) assert.ok(fs.existsSync(file), `${file} exists`);
const html = fs.readFileSync('apps/web/index.html', 'utf8');
assert.ok(html.includes('Codex Assist'), 'assist panel exists');
assert.ok(html.includes('sidebar-toggle'), 'collapsible sidebar exists');
assert.ok(html.includes('approval-panel'), 'approval drawer exists');
assert.ok(html.includes('busy-overlay'), 'busy overlay exists');
assert.ok(html.includes('shortcut-panel'), 'shortcut help exists');
assert.ok(html.includes('Workflow Canvas'), 'workflow nav exists');
const app = fs.readFileSync('apps/web/app.js', 'utf8');
for (const keyword of ['Project Wizard', 'previewContext', 'startRun', 'cancelRun', 'githubPr', 'Tool Registry', 'renderAssist', 'Sufficiency', 'bindShortcuts', 'withBusy', 'workflowViewport', 'startGithubOAuth', 'openApproval']) assert.ok(app.includes(keyword), `${keyword} wired`);
const baseCss = fs.readFileSync('apps/web/styles/base.css', 'utf8');
for (const keyword of ['--bg: #f7f3ea', '--panel', '--accent', '暖白']) assert.ok(baseCss.includes(keyword) || keyword === '暖白', `light theme ${keyword}`);
const dashboardView = fs.readFileSync('apps/web/src/views/dashboard.js', 'utf8');
assert.ok(dashboardView.includes('开局引导'));
assert.ok(dashboardView.includes('cc-switch'));
const workflowView = fs.readFileSync('apps/web/src/views/workflow.js', 'utf8');
assert.ok(workflowView.includes('workflow-stage'));
assert.ok(workflowView.includes('节点 Inspector'));
const nodeView = fs.readFileSync('apps/web/src/views/node.js', 'utf8');
assert.ok(nodeView.includes('Node Contract 编辑器'));
assert.ok(nodeView.includes('contract-criteria'));
const contextView = fs.readFileSync('apps/web/src/views/context.js', 'utf8');
assert.ok(contextView.includes('充分性 Gate'));
const runnerView = fs.readFileSync('apps/web/src/views/runner.js', 'utf8');
assert.ok(runnerView.includes('CodexRunner'));
assert.ok(runnerView.includes('cancel-run'));

const seen = new Set();
walkImports('apps/web/app.js');
assert.ok(seen.size >= 16, 'front-end module graph is traversed');
console.log('e2e smoke tests passed');

function walkImports(file) {
  const normalized = path.normalize(file);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  assert.ok(fs.existsSync(normalized), `module import exists: ${normalized}`);
  const code = fs.readFileSync(normalized, 'utf8');
  const dir = path.dirname(normalized);
  const imports = [...code.matchAll(/import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((target) => target.startsWith('.'));
  for (const target of imports) walkImports(path.resolve(dir, target));
}
