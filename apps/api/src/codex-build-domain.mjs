import { redactKnownSecretsSync } from './vault.mjs';

export const CODEX_BUILD_PHASES = Object.freeze([
  { key: 'runtime_check', label: '运行时检查' },
  { key: 'preparing', label: '准备构建' },
  { key: 'building', label: '构建镜像' },
  { key: 'verifying', label: '验证镜像' },
  { key: 'completed', label: '完成' }
]);

export function buildPhase(index) {
  return { ...CODEX_BUILD_PHASES[index], index: index + 1, total: CODEX_BUILD_PHASES.length };
}

export function classifyBuildFailure(value) {
  const text = String(value || '').toLowerCase();
  if (/no space left on device|disk(?: quota)? (?:is )?full|insufficient disk/.test(text))
    return buildFailure('docker_build_disk_full');
  if (/permission denied|access is denied|unauthorized|eacces|eperm/.test(text))
    return buildFailure('docker_build_permission_denied');
  if (
    /network is unreachable|connection (?:reset|refused|timed out)|temporary failure|tls handshake timeout|i\/o timeout|proxyconnect|eai_again|enotfound|failed to fetch|could not resolve/.test(
      text
    )
  )
    return buildFailure('docker_build_network_failed');
  if (
    /docker daemon|docker api|cannot connect to (?:the )?docker|is the docker daemon running|dockerdesktoplinuxengine|enoent|not recognized|command not found/.test(
      text
    )
  )
    return buildFailure('docker_unavailable');
  return buildFailure('docker_build_failed');
}

export function sanitizeBuildLog(value) {
  let text = redactKnownSecretsSync(String(value || ''));
  text = text.replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '***MASKED***');
  text = text.replace(/\b(api[_-]?key|token|authorization|password)(\s*[:=]\s*)([^\s]+)/gi, '$1$2***MASKED***');
  text = text.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return candidate.replace(/\?.*$/, '');
    }
  });
  return text.trimEnd();
}

export function buildFailure(code) {
  const catalog = {
    docker_unavailable: [
      'Docker 当前不可用',
      '启动 Docker Desktop，确认使用 Linux containers，并检查当前用户的 Docker 权限。',
      true
    ],
    docker_image_missing_in_deployment: [
      '部署所需 Runner 镜像不可用',
      '在宿主重新执行当前版本的 up/verify 构建 Runner 镜像。',
      false
    ],
    docker_build_network_failed: ['Docker Build 网络请求失败', '检查网络、DNS 和 Docker 代理配置后重试。', true],
    docker_build_disk_full: ['Docker 存储空间不足', '清理 Docker Build Cache 或扩展 Docker 磁盘空间后重试。', true],
    docker_build_permission_denied: ['Docker Build 权限不足', '确认当前用户可访问 Docker 引擎和项目目录后重试。', true],
    docker_build_timeout: ['Docker Build 超过 10 分钟', '检查构建日志、网络和 Docker 资源占用后重试。', true],
    docker_build_cancelled: ['Codex 镜像构建已取消', '可以重新开始构建。', true],
    docker_image_verification_failed: ['镜像构建完成但验证失败', '检查 Docker 镜像存储和权限，然后重新构建。', true],
    docker_build_failed: ['Codex 隔离镜像构建失败', '查看最新构建日志，修复 Dockerfile、网络或依赖问题后重试。', true]
  };
  const [message, action, retryable] = catalog[code] || catalog.docker_build_failed;
  return { error_code: code, message, action, retryable };
}
