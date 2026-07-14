import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareCodexInvocation } from './codex-command.mjs';
import {
  AIWS_RUNNER_IMAGE,
  RunnerStatus,
  agentsAiwsBlock,
  buildNodeRunResult,
  normalizeRunnerOutput
} from '../../shared/index.mjs';

export class AgentRunner {
  constructor(name) { this.name = name; }
  async run() { throw new Error('AgentRunner.run must be implemented'); }
}

export class CodexRunner extends AgentRunner {
  constructor({ command = 'codex', timeoutMs = 120000 } = {}) {
    super('CodexRunner');
    const invocation = prepareCodexInvocation(command);
    this.command = invocation.command;
    this.commandArgs = invocation.args;
    this.timeoutMs = timeoutMs;
  }

  buildArgs({ cwd, outputSchemaFile, lastMessageFile, model, json = true }) {
    return [...this.commandArgs, 'exec', ...(json ? ['--json'] : []), '--skip-git-repo-check', ...(model ? ['--model', model] : []), '--cd', cwd, '--output-schema', outputSchemaFile, ...(lastMessageFile ? ['--output-last-message', lastMessageFile] : []), '-'];
  }

  async run({ cwd, model, env, promptFile, outputSchemaFile, fallback = {}, signal }) {
    try {
      const lastMessageFile = `${outputSchemaFile}.last-message.json`;
      const args = this.buildArgs({ cwd, model, outputSchemaFile, lastMessageFile });
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const raw = await runProcess(this.command, args, { cwd, timeoutMs: this.timeoutMs, stdin: prompt, env, signal });
      const last = fs.existsSync(lastMessageFile) ? fs.readFileSync(lastMessageFile, 'utf8') : '';
      const normalized = normalizeRunnerOutput(last || extractJsonMessage(raw.stdout) || raw.stdout || raw.stderr, fallback);
      return { ...normalized.result, status: normalized.status, _codex_process: { code: raw.code, stderr: raw.stderr, stdout: raw.stdout.slice(-4000) } };
    } catch (error) {
      return partialCodexResult(fallback, error);
    }
  }
}

export class DockerCodexRunner extends AgentRunner {
  constructor({ image = AIWS_RUNNER_IMAGE, timeoutMs = 120000, invocationBuilder = null, processRunner = runProcess } = {}) {
    super('DockerCodexRunner');
    this.image = image;
    this.timeoutMs = timeoutMs;
    this.invocationBuilder = invocationBuilder;
    this.processRunner = processRunner;
  }

  buildDockerArgs({ cwd, codexHome = '.ai-workspace/codex-home', mounts = [], outputSchemaFile, lastMessageFile, model, json = true, exposeApiKey = false }) {
    if (this.invocationBuilder) return this.invocationBuilder({ cwd, codexHome, mounts, outputSchemaFile, lastMessageFile, model, json, exposeApiKey }).args;
    const mountedCwd = '/workspace';
    const mountedCodex = '/codex-home';
    const schemaPath = toContainerPath(outputSchemaFile, cwd, mountedCwd);
    const lastPath = lastMessageFile ? toContainerPath(lastMessageFile, cwd, mountedCwd) : null;
    return [
      'run', '--rm',
      '-v', `${cwd}:${mountedCwd}`,
      '--env', `CODEX_HOME=${mountedCodex}`,
      ...(exposeApiKey ? ['--env', 'OPENAI_API_KEY'] : []),
      '-v', `${codexHome}:${mountedCodex}`,
      ...mounts.flatMap((mount, index) => ['-v', `${mount}:/aiws-mounts/${index}:rw`]),
      '-w', mountedCwd,
      this.image,
      'exec',
      ...(json ? ['--json'] : []),
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      ...(model ? ['--model', model] : []),
      '--cd', mountedCwd,
      '--output-schema', schemaPath,
      ...(lastPath ? ['--output-last-message', lastPath] : []),
      '-'
    ];
  }

  async run({ cwd, codexHome, mounts, model, env, promptFile, outputSchemaFile, fallback = {}, signal }) {
    try {
      const lastMessageFile = `${outputSchemaFile}.last-message.json`;
      const input = { cwd, codexHome, mounts, model, json: true, outputSchemaFile, lastMessageFile, exposeApiKey: Boolean(env?.OPENAI_API_KEY) };
      const invocation = this.invocationBuilder ? this.invocationBuilder(input) : { command: 'docker', args: this.buildDockerArgs(input) };
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const raw = await this.processRunner(invocation.command, invocation.args, { cwd, timeoutMs: this.timeoutMs, stdin: prompt, env, signal }, invocation);
      const last = fs.existsSync(lastMessageFile) ? fs.readFileSync(lastMessageFile, 'utf8') : '';
      const normalized = normalizeRunnerOutput(last || extractJsonMessage(raw.stdout) || raw.stdout || raw.stderr, fallback);
      return { ...normalized.result, status: normalized.status, _codex_process: { command: 'docker', code: raw.code, stderr: raw.stderr, stdout: raw.stdout.slice(-4000) } };
    } catch (error) {
      return partialCodexResult(fallback, error);
    }
  }
}

function toContainerPath(file, hostRoot, mountedRoot) {
  const rel = path.relative(hostRoot, file).replaceAll('\\', '/');
  return rel && !rel.startsWith('..') ? `${mountedRoot}/${rel}` : file;
}

export function ensureAgentsBlock(repoPath, contextPackPath = '.ai-workspace/context/current.md') {
  const file = path.join(repoPath, 'AGENTS.md');
  const block = agentsAiwsBlock(contextPackPath);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = current.includes('<!-- AIWS:BEGIN -->')
    ? current.replace(/<!-- AIWS:BEGIN -->[\s\S]*?<!-- AIWS:END -->\n?/m, block)
    : `${current.trim()}\n\n${block}`.trimStart();
  fs.writeFileSync(file, next, 'utf8');
  return { file, changed: next !== current, content: next };
}


function partialCodexResult(fallback, error) {
  return {
    ...fallback,
    status: RunnerStatus.Partial,
    summary: 'CodexRunner 未能完成，已保留错误与 raw trace，可在确认配置后重试。',
    changed_files: fallback.changed_files || [],
    asset_candidates: fallback.asset_candidates || [],
    test_results: [{ name: 'codex exec', status: 'failed', output: String(error.message || error) }],
    next_actions: ['查看 raw output', '确认 Codex Profile 与挂载', '重试 CodexRunner'],
    warnings: [...(fallback.warnings || []), String(error.message || error)],
    _codex_process: { error: String(error.message || error) }
  };
}

function extractJsonMessage(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const candidate = event.message || event.content || event.text || event.output || event.last_message;
      if (typeof candidate === 'string' && candidate.trim().startsWith('{')) return candidate;
    } catch { /* keep scanning */ }
  }
  return '';
}

function runProcess(command, args, { cwd, timeoutMs, stdin = '', env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: processEnvironment(env) });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
    const abort = () => { child.kill('SIGTERM'); finish(reject, new Error('process cancelled')); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(reject, new Error(`process timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(stdin);
  });
}

function processEnvironment(overrides) {
  if (!overrides) return process.env;
  const result = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete result[key];
    else result[key] = String(value);
  }
  return result;
}
