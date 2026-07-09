import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  RunnerStatus,
  agentsAiwsBlock,
  buildNodeRunResult,
  normalizeRunnerOutput
} from '../../shared/index.mjs';

export class AgentRunner {
  constructor(name) { this.name = name; }
  async run() { throw new Error('AgentRunner.run must be implemented'); }
}

export class MockRunner extends AgentRunner {
  constructor() { super('MockRunner'); }
  async run(payload) { return runMock(payload); }
}

export class CodexRunner extends AgentRunner {
  constructor({ command = 'codex', timeoutMs = 120000 } = {}) {
    super('CodexRunner');
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  buildArgs({ cwd, outputSchemaFile, lastMessageFile, json = true }) {
    return ['exec', ...(json ? ['--json'] : []), '--skip-git-repo-check', '--cd', cwd, '--output-schema', outputSchemaFile, ...(lastMessageFile ? ['--output-last-message', lastMessageFile] : []), '-'];
  }

  async run({ cwd, promptFile, outputSchemaFile, fallback = {} }) {
    try {
      const lastMessageFile = `${outputSchemaFile}.last-message.json`;
      const args = this.buildArgs({ cwd, outputSchemaFile, lastMessageFile });
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const raw = await runProcess(this.command, args, { cwd, timeoutMs: this.timeoutMs, stdin: prompt });
      const last = fs.existsSync(lastMessageFile) ? fs.readFileSync(lastMessageFile, 'utf8') : '';
      const normalized = normalizeRunnerOutput(last || extractJsonMessage(raw.stdout) || raw.stdout || raw.stderr, fallback);
      return { ...normalized.result, status: normalized.status, _codex_process: { code: raw.code, stderr: raw.stderr, stdout: raw.stdout.slice(-4000) } };
    } catch (error) {
      return partialCodexResult(fallback, error);
    }
  }
}

export async function runMock({ run = { id: 'run_mock' }, contextPack, changedFiles = [] } = {}) {
  return buildNodeRunResult({ run, contextPack, changedFiles, raw: 'MockRunner deterministic output', status: RunnerStatus.Succeeded });
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
    summary: 'CodexRunner 未能完成，已保留错误与 raw trace，可切换 MockRunner 或重试。',
    changed_files: fallback.changed_files || [],
    asset_candidates: fallback.asset_candidates || [],
    test_results: [{ name: 'codex exec', status: 'failed', output: String(error.message || error) }],
    next_actions: ['查看 raw output', '确认是否重试 CodexRunner', '必要时切换 MockRunner'],
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

function runProcess(command, args, { cwd, timeoutMs, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`process timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}
