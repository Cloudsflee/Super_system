import path from 'node:path';
import { ROOT } from './config.mjs';
import { command } from './http.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { inspectCodexRuntimeLive } from './codex-runtime-status.mjs';
import { DEFAULT_RUNNER_IMAGE, isContainerized } from './container-runtime-config.mjs';

export function buildCodexDockerImage({ adapted = false, image = process.env.AIWS_CODEX_DOCKER_IMAGE || DEFAULT_RUNNER_IMAGE } = {}) {
  if (adapted) return { ready: true, runtime: { ready: true, image: { error_code: null } }, output: 'test adapter: image ready' };
  const before = inspectCodexRuntimeLive({ image });
  if (!before.docker.ok) return failure(before.docker.error_code, before.docker.summary, before.docker.action);
  if (isContainerized()) return before.ready
    ? { ready: true, runtime: before, output: 'deployment image ready' }
    : failure(before.image?.error_code || 'codex_probe_image_missing', '部署所需 Runner 镜像不可用', '在宿主重新执行当前版本的 up/verify 构建 Runner 镜像。', before);
  const proxyEnv = codexContainerProxyEnv(process.env);
  const args = ['build', '--progress=plain'];
  for (const key of Object.keys(proxyEnv)) args.push('--build-arg', key);
  args.push('-f', path.join(ROOT, 'docker', 'codex-runner.Dockerfile'), '-t', image, '.');
  const result = command('docker', args, ROOT, 600000, proxyEnv);
  const runtime = inspectCodexRuntimeLive({ image });
  if (!result.ok) return failure('docker_build_failed', 'Codex 隔离镜像构建失败', '检查 Docker 构建日志和网络代理后重试。', runtime);
  if (!runtime.ready) return failure(runtime.image?.error_code || 'codex_probe_image_inspection_failed', runtime.image?.summary || 'Codex 隔离镜像状态无法确认', runtime.image?.action || '检查 Docker 权限与引擎状态后重试。', runtime);
  return { ready: true, runtime, output: String(result.stdout || '').slice(-2000) };
}

function failure(errorCode, message, action, runtime = null) {
  return { ready: false, error_code: errorCode, message, action, runtime, output: '' };
}
