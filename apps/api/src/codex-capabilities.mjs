import { ROOT } from './config.mjs';
import { command } from './http.mjs';
import { DEFAULT_CODEX_IMAGE } from './codex-runtime-status.mjs';

export const SUPPORTED_CODEX_VERSION = process.env.AIWS_CODEX_VERSION || '0.144.0';

export function probeCodexCapabilities({ adapted = false, profile = null, commandRunner = command } = {}) {
  if (adapted) return adaptedCapabilities(profile);
  const binary = process.env.AIWS_CODEX_BIN || 'codex';
  const hostVersion = commandRunner(binary, ['--version'], ROOT, 5000);
  const hostHelp = hostVersion.ok ? commandRunner(binary, ['--help'], ROOT, 5000) : hostVersion;
  const appServer = hostVersion.ok ? commandRunner(binary, ['app-server', '--help'], ROOT, 5000) : hostVersion;
  const execHelp = hostVersion.ok ? commandRunner(binary, ['exec', '--help'], ROOT, 5000) : hostVersion;
  const version = parseVersion(hostVersion.stdout);
  const host = capabilityRecord({ version, versionResult: hostVersion, help: hostHelp.stdout, appServer, execHelp });
  const docker = inspectDocker(profile, commandRunner);
  const selected = profile?.kind === 'docker' ? docker : host;
  return {
    supported_version: SUPPORTED_CODEX_VERSION,
    compatible: selected.available && selected.version === SUPPORTED_CODEX_VERSION,
    guided_transport: selected.app_server ? 'app-server' : selected.exec_json ? 'exec-json' : 'unavailable',
    host, docker, selected_runtime: profile?.kind === 'docker' ? 'docker' : 'host', checked_at: new Date().toISOString()
  };
}

function inspectDocker(profile, commandRunner) {
  const image = profile?.config?.image || profile?.image || process.env.AIWS_CODEX_DOCKER_IMAGE || DEFAULT_CODEX_IMAGE;
  const versionResult = commandRunner('docker', ['run', '--rm', image, '--version'], ROOT, 15000);
  if (!versionResult.ok) return { available: false, version: null, version_supported: false, app_server: false, exec_json: false, resume: false, tty: false, image, error_code: 'codex_docker_capability_unavailable' };
  const appServer = commandRunner('docker', ['run', '--rm', image, 'app-server', '--help'], ROOT, 15000);
  const execHelp = commandRunner('docker', ['run', '--rm', image, 'exec', '--help'], ROOT, 15000);
  return { ...capabilityRecord({ version: parseVersion(versionResult.stdout), versionResult, help: '', appServer, execHelp }), image };
}
function capabilityRecord({ version, versionResult, help, appServer, execHelp }) {
  const execText = `${execHelp.stdout || ''}\n${execHelp.stderr || ''}`;
  return {
    available: versionResult.ok === true, version, version_supported: version === SUPPORTED_CODEX_VERSION,
    app_server: appServer.ok === true, exec_json: execHelp.ok === true && /--json/.test(execText),
    resume: execHelp.ok === true && /resume/.test(execText), tty: versionResult.ok === true,
    reasoning_summary: /reasoning|summary/i.test(`${help || ''}\n${execText}`), error_code: versionResult.ok ? null : 'codex_cli_missing'
  };
}
function parseVersion(value) { return String(value || '').match(/(\d+\.\d+\.\d+)/)?.[1] || null; }
function adaptedCapabilities(profile) { const selected = { available: true, version: SUPPORTED_CODEX_VERSION, version_supported: true, app_server: true, exec_json: true, resume: true, tty: true, reasoning_summary: true, error_code: null }; return { supported_version: SUPPORTED_CODEX_VERSION, compatible: true, guided_transport: 'app-server', host: selected, docker: { ...selected, image: DEFAULT_CODEX_IMAGE }, selected_runtime: profile?.kind === 'docker' ? 'docker' : 'host', checked_at: new Date().toISOString() }; }

