import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, saveArtifact } from '../state.mjs';
import { CodexRunner, DockerCodexRunner } from '../../../../packages/runner-adapters/src/index.mjs';
import { RunnerStatus, buildNodeRunResult, contextPackToMarkdown, nodeRunResultSchema, now } from '../../../../packages/shared/index.mjs';

export async function executeRunner(state, { actor, run, project, workspace, node, ctx, body }) {
  const repoPath = project.repo_path || project.workspace_root || '';
  const changedFiles = [];
  if (run.runner === 'codex_docker') return executeCodexDocker(state, { actor, run, project, workspace, node, ctx, repoPath });
  if (run.runner === 'codex' && body.force_mock === false) return executeCodex(state, { actor, run, project, workspace, node, ctx, repoPath });
  if (repoPath && fs.existsSync(repoPath) && body.mock_write !== false) await writeMockMarker(repoPath, run, node, changedFiles);
  else changedFiles.push({ path: 'virtual://mock-run-result.md', status: 'generated', source: 'mock_runner' });
  const raw = `MockRunner completed ${node.title}`;
  return persistRunnerResult(state, { actor, run, project, workspace, node, ctx, raw, resultJson: buildNodeRunResult({ run, contextPack: ctx, changedFiles, raw, status: RunnerStatus.Succeeded }) });
}

async function executeCodexDocker(state, payload) {
  const { run, ctx, repoPath } = payload;
  const cwd = repoPath && fs.existsSync(repoPath) ? repoPath : ROOT;
  const files = await prepareCodexFiles(cwd, run, ctx);
  const runner = new DockerCodexRunner({ image: process.env.AIWS_CODEX_DOCKER_IMAGE || 'aiws-codex-runner:local' });
  const fallback = buildNodeRunResult({ run, contextPack: ctx, changedFiles: [], raw: 'DockerCodexRunner command prepared', status: RunnerStatus.Partial });
  const resultJson = await runner.run({ cwd, aiwsHome: path.join(ROOT, '.ai-workspace'), promptFile: files.promptFile, outputSchemaFile: files.schemaFile, fallback });
  return persistRunnerResult(state, { ...payload, raw: resultJson._codex_process?.stderr || resultJson.summary, resultJson: { ...fallback, ...resultJson, changed_files: resultJson.changed_files || [] } });
}

async function executeCodex(state, payload) {
  const { run, project, node, ctx, repoPath } = payload;
  const cwd = repoPath && fs.existsSync(repoPath) ? repoPath : ROOT;
  const files = await prepareCodexFiles(cwd, run, ctx);
  const fallback = buildNodeRunResult({ run, contextPack: ctx, changedFiles: [], raw: 'CodexRunner fallback', status: RunnerStatus.Partial });
  const resultJson = await new CodexRunner({ timeoutMs: Number(process.env.AIWS_CODEX_TIMEOUT_MS || 120000) }).run({ cwd, promptFile: files.promptFile, outputSchemaFile: files.schemaFile, fallback });
  return persistRunnerResult(state, { ...payload, raw: resultJson._codex_process?.stderr || resultJson.summary, resultJson: { ...fallback, ...resultJson, changed_files: resultJson.changed_files || [] } });
}

async function prepareCodexFiles(cwd, run, ctx) {
  const dir = path.join(cwd, '.ai-workspace', 'runs', run.id);
  await fsp.mkdir(dir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  const schemaFile = path.join(dir, 'result-schema.json');
  await fsp.writeFile(promptFile, contextPackToMarkdown(ctx), 'utf8');
  await fsp.writeFile(schemaFile, JSON.stringify(nodeRunResultSchema(), null, 2), 'utf8');
  return { promptFile, schemaFile };
}

async function writeMockMarker(repoPath, run, node, changedFiles) {
  const markerDir = path.join(repoPath, '.aiws-demo');
  await fsp.mkdir(markerDir, { recursive: true });
  const marker = path.join(markerDir, `${run.id}.md`);
  await fsp.writeFile(marker, `# AIWS MockRunner Output\n\n- run: ${run.id}\n- node: ${node.title}\n- time: ${now()}\n`, 'utf8');
  changedFiles.push({ path: path.relative(repoPath, marker).replaceAll('\\', '/'), status: 'added', source: 'mock_runner' });
}

async function persistRunnerResult(state, { actor, run, project, workspace, node, raw, resultJson }) {
  const rawRef = await saveArtifact('runs', `${run.id}.raw.log`, JSON.stringify({ raw, result: resultJson }, null, 2), { run_id: run.id });
  state.file_refs.push(rawRef);
  Object.assign(run, { status: resultJson.status || RunnerStatus.Succeeded, summary: resultJson.summary, result_json: resultJson, raw_output_file_ref_id: rawRef.id, completed_at: now(), updated_at: now() });
  node.status = run.status === RunnerStatus.Succeeded ? 'needs_review' : 'blocked';
  traceRunnerResult(state, { actorId: actor.id, project, workspace, node, run, rawRef, resultJson });
  return { run, changedFiles: resultJson.changed_files || [], rawRef, resultJson };
}

function traceRunnerResult(state, { actorId, project, workspace, node, run, rawRef, resultJson }) {
  addTrace(state, 'runner.output', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: 'Runner 输出已归一化。', raw_file_ref_id: rawRef.id, data: resultJson }, actorId);
  addTrace(state, run.status === RunnerStatus.Succeeded ? 'runner.completed' : 'runner.failed', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: `Runner terminal status: ${run.status}` }, actorId);
  for (const file of resultJson.changed_files || []) addTrace(state, 'file.changed', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: `文件变化：${file.path || file.file}`, data: file }, actorId);
}

export function cancelRunInState(state, runId, actorId) {
  const run = state.node_runs.find((item) => item.id === runId);
  if (!run) throw new HttpError(404, 'run_not_found');
  if (![RunnerStatus.Queued, RunnerStatus.Running].includes(run.status)) return run;
  Object.assign(run, { status: RunnerStatus.Cancelled, completed_at: now(), updated_at: now() });
  const node = state.workflow_nodes.find((item) => item.id === run.node_id);
  if (node) node.status = 'blocked';
  addTrace(state, 'runner.cancelled', { project_id: run.project_id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id, summary: '用户取消 NodeRun。' }, actorId);
  return run;
}
