import { ROOT } from './config.mjs';
import { command } from './http.mjs';
import { DEFAULT_RUNNER_IMAGE } from './container-runtime-config.mjs';

export const DEFAULT_CODEX_IMAGE = DEFAULT_RUNNER_IMAGE;

export function inspectCodexRuntimeLive({ commandRunner = command, image = process.env.AIWS_CODEX_DOCKER_IMAGE || DEFAULT_CODEX_IMAGE } = {}) {
  const dockerResult = commandRunner('docker', ['info', '--format', '{{.ServerVersion}}'], ROOT, 5000);
  const docker = {
    ok: dockerResult.ok === true,
    available: dockerResult.ok === true,
    version: dockerResult.ok ? String(dockerResult.stdout || '').trim() : '',
    error_code: dockerResult.ok ? null : dockerErrorCode(dockerResult),
    summary: dockerResult.ok ? 'Docker 引擎可用' : 'Docker 引擎当前不可用',
    action: dockerResult.ok ? null : '启动 Docker Desktop，确认使用 Linux containers，然后重新检测。'
  };
  const imageResult = docker.ok
    ? commandRunner('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], ROOT, 5000)
    : { ok: false, status: null, stdout: '', stderr: '', error: 'docker_unavailable' };
  const imageError = imageResult.ok ? null : docker.ok ? imageErrorCode(imageResult) : 'codex_probe_docker_unavailable';
  const imageStatus = {
    ok: imageResult.ok === true,
    ready: imageResult.ok === true,
    name: image,
    id: imageResult.ok ? String(imageResult.stdout || '').trim() : null,
    error_code: imageError,
    summary: imageResult.ok ? 'Codex 隔离镜像可用' : imageError === 'codex_probe_image_missing' ? 'Codex 隔离镜像不存在' : imageError === 'codex_probe_docker_unavailable' ? '等待 Docker 引擎' : 'Codex 隔离镜像状态无法确认',
    action: imageResult.ok ? null : imageError === 'codex_probe_image_missing' ? '点击“检测并构建”创建 Codex 隔离镜像。' : imageError === 'codex_probe_docker_unavailable' ? docker.action : '检查 Docker 权限与引擎状态，然后重新检测。'
  };
  return { ready: docker.ok && imageStatus.ok, checked_at: new Date().toISOString(), docker, image: imageStatus };
}

function dockerErrorCode(result) {
  const text = `${result?.error || ''}\n${result?.stderr || ''}`.toLowerCase();
  if (/enoent|not recognized|command not found|executable file not found/.test(text)) return 'codex_probe_cli_missing';
  return 'codex_probe_docker_unavailable';
}

function imageErrorCode(result) {
  const text = `${result?.error || ''}\n${result?.stderr || ''}`.toLowerCase();
  if (/no such image|unable to find image|pull access denied/.test(text)) return 'codex_probe_image_missing';
  if (/dockerdesktoplinuxengine|docker daemon|docker api|cannot connect to (?:the )?docker|is the docker daemon running|\\\.\\pipe\\docker/.test(text)) return 'codex_probe_docker_unavailable';
  return 'codex_probe_image_inspection_failed';
}
