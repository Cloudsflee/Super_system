import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const required = [
  'apps/web/package.json', 'apps/web/src/main.tsx', 'apps/web/src/app/router.tsx',
  'apps/web/src/features/setup/SetupPage.tsx', 'apps/web/src/features/workflow/canvas/WorkflowCanvas.tsx',
  'apps/web/src/features/nodes/renderers/ExecutionWorkspace.tsx', 'apps/web/src/components/assist/AssistDrawer.tsx',
  'apps/web/src/features/projects/onboarding/ProjectOnboardingPage.tsx',
  'apps/web/src/features/assist/AssistWorkbench.tsx', 'apps/web/src/features/assist/TerminalPanel.tsx',
  'apps/web/src/features/assist/DiffReviewPanel.tsx', 'apps/web/src/components/approvals/ApprovalCenter.tsx'
];
for (const file of required) assert.ok(fs.existsSync(file), `${file} exists`);
for (const removed of ['apps/web/app.js', 'apps/web/boot.js', 'apps/api/src/routes/demo.mjs', 'tests/integration/demo-flow.test.mjs']) assert.equal(fs.existsSync(removed), false, `${removed} removed`);

const manifest = JSON.parse(fs.readFileSync('apps/web/package.json', 'utf8'));
for (const dependency of ['react', 'react-router-dom', '@tanstack/react-query', 'zustand', '@xyflow/react', 'lucide-react', '@monaco-editor/react', '@xterm/xterm', '@xterm/addon-fit']) assert.ok(manifest.dependencies[dependency], `${dependency} configured`);
const router = read('apps/web/src/app/router.tsx');
for (const route of ['/setup', '/integrations/github/install/setup', '/projects', '/projects/:projectId/onboarding', '/projects/:projectId/workflow', '/projects/:projectId/nodes/:nodeId', '/assets', '/audit', '/settings']) assert.ok(router.includes(route), `${route} route exists`);
const canvas = read('apps/web/src/features/workflow/canvas/WorkflowCanvas.tsx');
for (const capability of ['ReactFlow', 'saveLayout', 'onNodeDoubleClick', 'autoLayout', 'fitView']) assert.ok(canvas.includes(capability), `${capability} connected`);
const execution = read('apps/web/src/features/nodes/renderers/ExecutionWorkspace.tsx');
for (const capability of ['<Editor', '/files/content', '/files/diff', '/test-tasks', '/run']) assert.ok(execution.includes(capability), `${capability} connected`);
const assist = read('apps/web/src/components/assist/AssistDrawer.tsx');
for (const capability of ['EventSource', 'view_context', 'executeAction', '/actions/']) assert.ok(assist.includes(capability), `${capability} connected`);
const workbench = read('apps/web/src/features/assist/AssistWorkbench.tsx');
for (const capability of ['surface-${ui.assistSurface}', 'surface="docked"', 'surface="floating"', 'surface="fullscreen"', "setAssistSurface('minimized')", 'ThreadSidebar', 'TerminalPanel', 'DiffReviewPanel']) assert.ok(workbench.includes(capability), `Assist V3 ${capability} connected`);
const terminal = read('apps/web/src/features/assist/TerminalPanel.tsx');
for (const capability of ['@xterm/xterm', 'WebSocket', "signal: 'SIGINT'", "type: 'resize'"]) assert.ok(terminal.includes(capability), `Terminal ${capability} connected`);
const review = read('apps/web/src/features/assist/DiffReviewPanel.tsx');
for (const capability of ["name: 'viewed'", "name: 'comments'", "name: 'request-changes'", "name: 'apply'", "name: 'rollback'"]) assert.ok(review.includes(capability), `Review ${capability} connected`);

const runtimeFiles = walk('apps').concat(walk('packages')).filter((file) => /\.(mjs|ts|tsx|json|html|css)$/.test(file) && !file.includes('dist'));
const runtime = runtimeFiles.map(read).join('\n');
for (const forbidden of ['/demo/full-chain', 'MockRunner', 'mock_runner', '生成演示链路']) assert.equal(runtime.includes(forbidden), false, `runtime excludes ${forbidden}`);
auditButtons(walk('apps/web/src').filter((file) => file.endsWith('.tsx')));
for (const nodeInteraction of ['onNodeClick=', 'onNodeDoubleClick=', 'onConnect=']) assert.ok(canvas.includes(nodeInteraction), `canvas nodes connect ${nodeInteraction}`);
console.log(`V1.3 UI smoke passed (${runtimeFiles.length} runtime files)`);

function auditButtons(files) {
  const violations = [];
  for (const file of files) {
    const source = read(file);
    for (const tag of jsxTags(source, 'button')) if (!/onClick=|onSubmit=|type="submit"|disabled=|\sdisabled(?:\s|>)|\.\.\.props/.test(tag)) violations.push(`${file}: ${tag.slice(0, 100)}`);
    for (const tag of jsxTags(source, 'IconButton')) if (!/onClick=|disabled=|\.\.\.props/.test(tag)) violations.push(`${file}: ${tag.slice(0, 100)}`);
    for (const tag of [...jsxTags(source, 'NavLink'), ...jsxTags(source, 'Link')]) if (!/\sto=/.test(tag)) violations.push(`${file}: ${tag.slice(0, 100)}`);
    for (const tag of jsxTags(source, 'select')) if (!/onChange=|disabled=/.test(tag)) violations.push(`${file}: ${tag.slice(0, 100)}`);
  }
  assert.deepEqual(violations, [], `interactive controls have a command, link, or disabled state:\n${violations.join('\n')}`);
}
function jsxTags(source, name) {
  const tags = [];
  const needle = `<${name}`;
  for (let start = source.indexOf(needle); start >= 0; start = source.indexOf(needle, start + needle.length)) {
    if (!/[\s/>]/.test(source[start + needle.length] || '')) continue;
    let braces = 0, quote = '', escaped = false, end = start;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (!escaped && char === quote) quote = ''; escaped = !escaped && char === '\\'; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '{') braces++;
      else if (char === '}') braces = Math.max(0, braces - 1);
      else if (char === '>' && braces === 0) { tags.push(source.slice(start, end + 1)); break; }
    }
  }
  return tags;
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function walk(dir) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const full = path.join(dir, entry.name); if (['node_modules', 'dist'].includes(entry.name)) return []; return entry.isDirectory() ? walk(full) : [full]; }); }
