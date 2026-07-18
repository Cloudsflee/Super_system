import path from 'node:path';
import { AIWS_HOME } from './config.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { withCodexMcpEnvironment } from './codex-mcp-runtime.mjs';
import { buildCodexContainerInvocation } from './container-runtime-config.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';

export function terminalInvocation(profile, cwd, credential, sessionId, mcpAccess = null) {
  const codexHome = profile.codex_home || path.join(AIWS_HOME, 'codex-homes', profile.id);
  const proxy = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {};
  const env = withCodexMcpEnvironment({
    ...minimalTerminalEnv(),
    ...proxy,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CODEX_HOME: codexHome,
    ...(credential ? { OPENAI_API_KEY: credential } : {})
  }, mcpAccess);
  const requested = process.env.AIWS_CODEX_BIN || 'codex';
  const commandArgs = profile.kind === 'docker' || isCodexCliExecutable(requested) ? terminalCodexArgs(profile, mcpAccess) : [];
  if (profile.kind !== 'docker') return { ...prepareCodexInvocation(requested, commandArgs), env };
  return {
    ...buildCodexContainerInvocation({
      kind: 'terminal',
      sessionId,
      profileId: profile.id,
      image: profile.image || profile.config?.image,
      interactive: true,
      codexHome,
      workspace: cwd,
      workspaceMode: 'rw',
      extraMounts: profile.mounts || [],
      containerEnv: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CODEX_HOME: '/codex-home',
        ...(credential ? { OPENAI_API_KEY: null } : {}),
        ...(mcpAccess?.containerEnv || {}),
        ...Object.fromEntries(Object.keys(proxy).map((key) => [key, null]))
      },
      commandArgs
    }),
    env
  };
}

export function terminalCodexArgs(profile, mcpAccess = null) {
  return [...(mcpAccess?.configArgs || []), '--model', profile.model, '-c', `model_reasoning_effort=${JSON.stringify(profile.reasoning || 'high')}`];
}

function isCodexCliExecutable(value) {
  return /^codex(?:\.cmd|\.ps1|\.exe|\.js)?$/i.test(path.basename(String(value || '')));
}

function minimalTerminalEnv() {
  const names = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];
  return Object.fromEntries(names.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}
