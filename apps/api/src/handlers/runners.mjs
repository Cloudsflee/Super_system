import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http.mjs';
import { addTrace, saveArtifact } from '../state.mjs';
import { CodexRunner, DockerCodexRunner } from '../../../../packages/runner-adapters/src/index.mjs';
import { RunnerStatus, buildNodeRunResult, contextPackToMarkdown, runnerResultSchemaForContext, now } from '../../../../packages/shared/index.mjs';
import { readSecret } from '../vault.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from '../codex-service.mjs';
import { materializeDeviceAuth } from '../codex-device-auth.mjs';
import { codexContainerProxyEnv } from '../codex-container-network.mjs';
import { assertProfileAllowed, buildCodexContainerInvocation } from '../container-runtime-config.mjs';
import { runContainerProcess } from '../container-runtime.mjs';
import { issueCodexMcpAccess, withCodexMcpEnvironment } from '../codex-mcp-runtime.mjs';
import { codexTimeoutTtlSeconds, resolveCodexTimeoutMs } from '../codex-timeout.mjs';
import { EXECUTION_DIR } from '../config.mjs';

export async function invokeRunner(state, { actor, run, project, workspace, node, ctx, body }) {
  const repoPath = run.task_execution_context?.repository_snapshot?.managed_path || project.repo_path || project.workspace_root || '';
  if (!repoPath || !fs.existsSync(repoPath)) throw new HttpError(409, { error: 'repository_root_required_for_node_run' });
  if (run.runner === 'codex_docker') return executeCodexDocker(state, { actor, run, project, workspace, node, ctx, repoPath });
  if (run.runner === 'codex') return executeCodex(state, { actor, run, project, workspace, node, ctx, repoPath });
  throw new HttpError(400, { error: 'unsupported_runner', allowed: ['codex_docker', 'codex'] });
}

async function executeCodexDocker(state, payload) {
  const { run, ctx, repoPath, project } = payload;
  const cwd = repoPath;
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile?.codex_home) throw new HttpError(409, { error: 'active_codex_profile_required' });
  assertProfileAllowed(profile);
  const files = await prepareCodexFiles(cwd, run, ctx);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential);
  const proxyEnv = codexContainerProxyEnv(process.env);
  const timeoutMs = resolveCodexTimeoutMs(profile.timeout_ms);
  const mcpAccess = await issueCodexMcpAccess(project.id, profile, { ttlSeconds: codexTimeoutTtlSeconds(timeoutMs) });
  const runner = new DockerCodexRunner({
    image: process.env.AIWS_CODEX_DOCKER_IMAGE, timeoutMs,
    invocationBuilder: (input) => buildNodeRunInvocation(profile, run, input, Object.keys(proxyEnv), mcpAccess),
    processRunner: (_command, _args, options, invocation) => runContainerProcess(invocation, options)
  });
  const fallback = buildNodeRunResult({ run, contextPack: ctx, changedFiles: [], raw: 'DockerCodexRunner command prepared', status: RunnerStatus.Partial });
  try {
    const resultJson = await runner.run({ cwd, codexHome: profile.codex_home, mounts: profile.mounts || [], model: profile.model, env: withCodexMcpEnvironment({ ...proxyEnv, OPENAI_API_KEY: credential || undefined }, mcpAccess), configArgs: mcpAccess.configArgs, promptFile: files.promptFile, outputSchemaFile: files.schemaFile, fallback, signal: payload.body?.signal });
    return { raw: resultJson._codex_process?.stderr || resultJson.summary, resultJson: { ...fallback, ...resultJson, changed_files: resultJson.changed_files || [] } };
  } finally { await mcpAccess.release(); }
}

async function executeCodex(state, payload) {
  const { run, project, node, ctx, repoPath } = payload;
  const cwd = repoPath;
  const files = await prepareCodexFiles(cwd, run, ctx);
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile?.codex_home) throw new HttpError(409, { error: 'active_codex_profile_required' });
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential);
  const timeoutMs = resolveCodexTimeoutMs(profile.timeout_ms);
  const mcpAccess = await issueCodexMcpAccess(project.id, profile, { ttlSeconds: codexTimeoutTtlSeconds(timeoutMs) });
  const fallback = buildNodeRunResult({ run, contextPack: ctx, changedFiles: [], raw: 'CodexRunner fallback', status: RunnerStatus.Partial });
  try {
    const resultJson = await new CodexRunner({ timeoutMs }).run({ cwd, model: profile.model, env: withCodexMcpEnvironment({ CODEX_HOME: profile.codex_home, OPENAI_API_KEY: credential || undefined }, mcpAccess), configArgs: mcpAccess.configArgs, promptFile: files.promptFile, outputSchemaFile: files.schemaFile, fallback, signal: payload.body?.signal });
    return { raw: resultJson._codex_process?.stderr || resultJson.summary, resultJson: { ...fallback, ...resultJson, changed_files: resultJson.changed_files || [] } };
  } finally { await mcpAccess.release(); }
}

export function buildNodeRunInvocation(profile, run, input, proxyKeys, mcpAccess) {
  const readOnly = run.task_execution_context?.repository_checkout?.access === 'read_only';
  const runtimeDir = path.dirname(input.outputSchemaFile);
  const internalMounts = [{ source: runtimeDir, target: '/aiws-run', mode: 'rw' }];
  const gitMetadata = resolveGitMetadataMount(input.cwd);
  if (gitMetadata) internalMounts.push(gitMetadata);
  for (const item of run.task_execution_context?.asset_mounts || []) {
    const root = item.mount?.root;
    if (root && path.posix.isAbsolute(root)) internalMounts.push({ source: root, target: root, mode: 'ro' });
  }
  const commandArgs = [...(input.configArgs || []), 'exec', ...(input.json ? ['--json'] : []), '--skip-git-repo-check', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
  if (input.model) commandArgs.push('--model', input.model);
  commandArgs.push('--cd', '/workspace', '--output-schema', `/aiws-run/${path.basename(input.outputSchemaFile)}`);
  if (input.lastMessageFile) commandArgs.push('--output-last-message', `/aiws-run/${path.basename(input.lastMessageFile)}`);
  commandArgs.push('-');
  return buildCodexContainerInvocation({
    kind: 'node-run', sessionId: run.id, profileId: profile.id, image: profile.image,
    nestedSandbox: true,
    stdin: true, codexHome: input.codexHome, workspace: input.cwd, workspaceMode: readOnly ? 'ro' : 'rw', internalMounts, extraMounts: input.mounts,
    containerEnv: { CODEX_HOME: '/codex-home', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(input.exposeApiKey ? { OPENAI_API_KEY: null } : {}), ...(mcpAccess?.containerEnv || {}), ...Object.fromEntries(proxyKeys.map((key) => [key, null])) },
    commandArgs
  });
}

export async function prepareCodexFiles(_cwd, run, ctx) {
  const dir = path.join(EXECUTION_DIR, 'node-runs', run.id);
  await fsp.mkdir(dir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  const schemaFile = path.join(dir, 'result-schema.json');
  await fsp.writeFile(promptFile, contextPackToMarkdown(ctx), 'utf8');
  const executionContext = ctx.task_execution_context || ctx._task_execution_context || ctx.content_json?.task_execution_context;
  await fsp.writeFile(schemaFile, JSON.stringify(runnerResultSchemaForContext(executionContext), null, 2), 'utf8');
  return { promptFile, schemaFile };
}

export function resolveGitMetadataMount(cwd) {
  const marker = path.join(cwd, '.git');
  try {
    if (!fs.statSync(marker).isFile()) return null;
    const match = fs.readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)\s*$/im);
    if (!match) return null;
    const gitDir = path.resolve(cwd, match[1].trim());
    const commonRef = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    const commonDir = path.resolve(gitDir, commonRef);
    if (!path.posix.isAbsolute(commonDir) || !gitDir.startsWith(`${commonDir}${path.sep}`)) return null;
    return { source: commonDir, target: commonDir.split(path.sep).join('/'), mode: 'ro' };
  } catch { return null; }
}

export async function persistRunnerResult(state, { actor, run, project, workspace, node, raw, resultJson }) {
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
