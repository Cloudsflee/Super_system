import fs from 'node:fs';
import { DATA_DIR } from './config.mjs';
import { isContainerized } from './container-runtime-config.mjs';

export function dataDirectoryReady(directory = DATA_DIR) {
  try { fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK); return true; }
  catch { return false; }
}

export function deploymentStatus({ env = process.env, dockerReady = false, storageReady = dataDirectoryReady() } = {}) {
  const container = isContainerized(env);
  const gateway = env.AIWS_MCP_REMOTE_MODE === 'gateway';
  return {
    mode: container ? 'container' : 'host',
    local_only: !gateway,
    collaboration: { mode: gateway ? 'gateway' : 'local', mcp_gateway: gateway, public_endpoint_configured: Boolean(env.AIWS_PUBLIC_MCP_URL) },
    storage: { type: container ? 'docker_volume' : 'local_directory', ready: storageReady },
    docker: { strategy: container ? 'socket' : 'local_cli', ready: dockerReady },
    imports: {
      codex_home: importReady(env.AIWS_HOST_CODEX_HOME),
      cc_switch: importReady(env.AIWS_HOST_CC_SWITCH_CONFIG_DIR),
      projects_root: importReady(env.AIWS_HOST_PROJECTS_ROOT),
      project_path_mode: container ? 'relative' : 'absolute'
    }
  };
}

function importReady(value) {
  if (!value) return false;
  try { const stat = fs.lstatSync(value); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}
