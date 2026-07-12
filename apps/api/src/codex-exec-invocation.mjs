import path from 'node:path';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { buildCodexContainerInvocation, isContainerized } from './container-runtime-config.mjs';

export function buildCodexExecInvocation({ profile, prompt, cwd, resumeId, sandbox, exposeApiKey = false, proxyKeys = [], runtimeKind = 'assist-exec' }) {
  const configArgs = profile.reasoning ? ['-c', `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`] : [];
  const execArgs = resumeId ? [...configArgs, 'exec', 'resume', '--json', resumeId] : [...configArgs, 'exec', '--json'];
  execArgs.push('--sandbox', sandbox, '--skip-git-repo-check');
  if (profile.model) execArgs.push('--model', profile.model);
  execArgs.push(prompt);
  if (profile.kind !== 'docker') {
    const invocation = prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex');
    return { command: invocation.command, args: [...invocation.args, ...execArgs], safeArgs: [...invocation.args, ...execArgs.slice(0, -1), '[PROMPT]'] };
  }
  const invocation = buildCodexContainerInvocation({
    kind: runtimeKind, sessionId: resumeId || uniqueSession(), profileId: profile.id,
    image: profile.image, codexHome: profile.codex_home, workspace: path.resolve(cwd),
    workspaceMode: sandbox === 'read-only' ? 'ro' : 'rw', extraMounts: profile.mounts || [],
    containerEnv: { CODEX_HOME: '/codex-home', ...(exposeApiKey ? { OPENAI_API_KEY: null } : {}), ...Object.fromEntries(proxyKeys.map((key) => [key, null])) },
    commandArgs: execArgs
  });
  invocation.safeArgs = isContainerized() ? ['managed-container', runtimeKind, '[PROMPT]'] : invocation.args.slice(0, -1).concat('[PROMPT]');
  return invocation;
}

function uniqueSession() { return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
