import { parse as parseToml } from 'smol-toml';
import { AIWS_RUNNER_IMAGE } from '../../../packages/shared/index.mjs';
import { containerizeLoopbackUrl } from './codex-container-network.mjs';
import {
  isThirdParty,
  normalizeUrl,
  normalizedProvider,
  providerConfigKey,
  publicOverrides,
  publicProcess,
  sameProvider
} from './codex-probe-normalization.mjs';

export const CODEX_PROBE_PHASES = Object.freeze([
  'configuration',
  'runtime',
  'binding',
  'transport',
  'protocol',
  'model',
  'inference'
]);

const PHASE_LABELS = Object.freeze({
  configuration: '配置语法',
  runtime: 'Docker 运行时',
  binding: 'Endpoint / 凭据绑定',
  transport: '网络连接',
  protocol: 'Responses 协议',
  model: '模型可用性',
  inference: '真实非写入请求'
});

const FAILURES = Object.freeze({
  codex_probe_config_missing: ['configuration', 'Codex 配置文件不存在', '重新保存当前 Profile，再运行 Probe。', false],
  codex_probe_config_too_large: [
    'configuration',
    'Codex 配置文件超出允许大小',
    '移除异常配置内容并重新保存 Profile。',
    false
  ],
  codex_probe_config_invalid: [
    'configuration',
    'Codex 配置语法无效',
    '重新保存 Profile，让系统重建 config.toml。',
    false
  ],
  codex_probe_config_profile_mismatch: [
    'configuration',
    '磁盘配置与当前 Profile 不一致',
    '重新保存或导入 Profile，不要手工复制旧 config.toml。',
    false
  ],
  codex_probe_unsupported_wire_api: [
    'configuration',
    '当前 Provider 不是 Responses 协议',
    '选择支持 Responses API 的 Endpoint，或启用完整的协议转换代理。',
    false
  ],
  codex_probe_cc_switch_not_ready: [
    'configuration',
    'cc-switch Runtime Bridge 未就绪',
    '先同步 cc-switch 并确认当前 Profile 的 Provider 映射为已同步。',
    true
  ],
  codex_probe_docker_unavailable: [
    'runtime',
    'Docker 引擎当前不可用',
    '启动 Docker Desktop，确认已切换到 Linux containers，然后重试。',
    true
  ],
  codex_probe_image_missing: ['runtime', 'Codex 隔离镜像不存在', `重新部署 ${AIWS_RUNNER_IMAGE}。`, true],
  codex_probe_image_inspection_failed: [
    'runtime',
    'Codex 隔离镜像状态无法确认',
    '检查 Docker 权限与引擎状态，然后重新检测。',
    true
  ],
  codex_probe_mount_unavailable: [
    'runtime',
    'Profile 的隔离挂载不可用',
    '检查工作区路径和 Docker Desktop 文件共享权限。',
    false
  ],
  codex_probe_cli_missing: ['runtime', 'Codex CLI 无法启动', '重建 Codex 镜像，或检查本机 codex 命令是否可用。', false],
  codex_probe_auth_missing: [
    'binding',
    'Codex 凭据不存在或已失效',
    '重新选择官方账户登录、cc-switch、本地 Codex 配置或 API Key。',
    false
  ],
  codex_probe_auth_provider_mismatch: [
    'binding',
    '凭据 Provider 与 Profile 不匹配',
    '重新导入同一 Provider 的凭据与 Profile。',
    false
  ],
  codex_probe_auth_endpoint_mismatch: [
    'binding',
    '凭据 Endpoint 与 Profile 不匹配',
    '使用同一个 Base URL 重新认证并保存 Profile。',
    false
  ],
  codex_probe_credential_unavailable: [
    'binding',
    '凭据引用无法读取',
    '重新登录或导入配置，以恢复本地 Vault 凭据。',
    false
  ],
  codex_probe_endpoint_dns_failed: ['transport', 'Endpoint 域名无法解析', '检查 DNS、代理与 Base URL 的域名。', true],
  codex_probe_endpoint_tls_failed: ['transport', 'Endpoint TLS 校验失败', '检查证书链、系统时间与 HTTPS 代理。', false],
  codex_probe_endpoint_unreachable: [
    'transport',
    'Endpoint 网络不可达',
    '检查 Base URL、防火墙、代理和容器网络。',
    true
  ],
  codex_probe_endpoint_timeout: [
    'transport',
    'Endpoint 连接超时',
    '检查 Endpoint 和代理后重试；必要时增加 Profile 超时时间。',
    true
  ],
  codex_probe_timeout: [
    'inference',
    'Codex 探针在限定时间内未完成',
    '重试后检查 Endpoint 延迟、MCP 启动和 Profile 超时时间。',
    true
  ],
  codex_probe_configuration_changed: [
    'configuration',
    'Probe 执行期间配置发生变化',
    '重新运行 Probe，以校验当前最新配置。',
    true
  ],
  codex_probe_auth_rejected: [
    'binding',
    'Endpoint 拒绝了当前凭据',
    '确认 API Key / 官方账户仍有效，且属于当前 Endpoint。',
    false
  ],
  codex_probe_responses_route_not_found: [
    'protocol',
    'Endpoint 未提供 Responses API',
    '确认 Base URL 后可正确访问 /responses，不要填写仅支持 Chat Completions 的地址。',
    false
  ],
  codex_probe_protocol_rejected: [
    'protocol',
    'Endpoint 返回了不兼容的 Responses 协议内容',
    '检查第三方 API 的 Responses 兼容性与代理配置。',
    false
  ],
  codex_probe_model_not_found: [
    'model',
    'Endpoint 不识别当前模型',
    '从 Provider 可用模型列表中选择正确的 Model ID。',
    false
  ],
  codex_probe_model_access_denied: [
    'model',
    '当前凭据无权访问该模型',
    '更换有模型权限的凭据，或改用已授权的 Model ID。',
    false
  ],
  codex_probe_rate_limited: [
    'protocol',
    'Endpoint 当前限流或额度不足',
    '稍后重试，或检查 Provider 额度和限流策略。',
    true
  ],
  codex_probe_upstream_unavailable: ['protocol', 'Provider 服务暂时不可用', '稍后重试，并检查 Provider 状态。', true],
  codex_probe_response_marker_missing: [
    'inference',
    'Codex 请求完成，但未返回校验标记',
    '重试 Probe；若持续出现，检查模型是否能正常返回 agent_message。',
    true
  ],
  codex_probe_request_failed: ['inference', 'Codex 真实请求失败', '根据上方已通过和失败的检查项修复配置后重试。', true]
});

const DIAGNOSTIC_FAILURE_RULES = Object.freeze([
  [
    /\b(?:connect(?:ion)?|request|operation)[^\n]{0,80}(?:timed? out|timeout)\b|\b(?:timed? out|timeout)[^\n]{0,80}(?:connect(?:ion)?|request|operation)\b/,
    'codex_probe_endpoint_timeout'
  ],
  [
    /dockerdesktoplinuxengine|docker daemon|docker api|cannot connect to (?:the )?docker|is the docker daemon running|\\\\\.\\pipe\\docker/,
    'codex_probe_docker_unavailable'
  ],
  [/unable to find image|no such image|pull access denied/, 'codex_probe_image_missing'],
  [
    /invalid mount config|mount denied|drive is not shared|bind source path does not exist/,
    'codex_probe_mount_unavailable'
  ],
  [/enoent|not recognized as an internal|command not found|executable file not found/, 'codex_probe_cli_missing'],
  [
    /toml parse error|failed to parse.*config|invalid configuration|unknown variant.*wire_api/,
    'codex_probe_config_invalid'
  ],
  [
    /model[_ -]?not[_ -]?found|unknown model|model .* does not exist|404[^\n]{0,160}\bmodel\b|\bmodel\b[^\n]{0,160}404/,
    'codex_probe_model_not_found'
  ],
  [
    /does not have access to model|model access (?:denied|forbidden)|not authorized (?:to use|for).*model/,
    'codex_probe_model_access_denied'
  ],
  [
    /401|unauthorized|invalid api key|incorrect api key|authentication failed|invalid[_ -]?token|token.*expired/,
    'codex_probe_auth_rejected'
  ],
  [/403|forbidden|permission denied/, forbiddenFailureCode],
  [
    /enotfound|eai_again|dns error|failed to lookup address|name or service not known|no such host/,
    'codex_probe_endpoint_dns_failed'
  ],
  [/certificate|unknown issuer|self[- ]signed|tls|ssl|invalid peer certificate/, 'codex_probe_endpoint_tls_failed'],
  [
    /econnrefused|econnreset|network is unreachable|connection refused|connection reset|error sending request|failed to connect/,
    'codex_probe_endpoint_unreachable'
  ],
  [
    /(?=[\s\S]*(?:404|method not allowed|405))(?=[\s\S]*(?:responses|endpoint|route|url))/,
    'codex_probe_responses_route_not_found'
  ],
  [/429|too many requests|rate.?limit|insufficient_quota|quota exceeded/, 'codex_probe_rate_limited'],
  [
    /\b(?:500|502|503|504)\b|bad gateway|service unavailable|gateway timeout|upstream/,
    'codex_probe_upstream_unavailable'
  ],
  [
    /invalid response|unexpected response|failed to deserialize|decode.*response|responses api/,
    'codex_probe_protocol_rejected'
  ]
]);

export function probeFailure(errorCode, overrides = {}) {
  const definition = FAILURES[errorCode] || FAILURES.codex_probe_request_failed;
  const [phase, summary, action, retryable] = definition;
  return {
    ok: false,
    phase,
    error_code: FAILURES[errorCode] ? errorCode : 'codex_probe_request_failed',
    summary,
    action,
    retryable,
    ...publicOverrides(overrides)
  };
}

export function probeCheck(phase, status = 'passed', failure = null) {
  if (!CODEX_PROBE_PHASES.includes(phase)) throw new TypeError(`unknown_probe_phase:${phase}`);
  const check = { phase, label: PHASE_LABELS[phase], status };
  if (failure?.error_code)
    Object.assign(check, {
      error_code: failure.error_code,
      summary: failure.summary,
      action: failure.action,
      retryable: failure.retryable
    });
  return check;
}

export function inspectCodexConfig(profile, text) {
  if (typeof text !== 'string' || !text.trim()) return probeFailure('codex_probe_config_missing');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) return probeFailure('codex_probe_config_too_large');
  const parsed = parseCodexConfig(text);
  if (!parsed) return probeFailure('codex_probe_config_invalid');
  if (!profile?.model || String(parsed.model || '') !== String(profile.model))
    return probeFailure('codex_probe_config_profile_mismatch');
  const failure = isThirdParty(profile?.provider)
    ? thirdPartyConfigFailure(profile, parsed)
    : officialConfigFailure(parsed);
  return failure ? probeFailure(failure) : { ok: true, check: probeCheck('configuration') };
}

function parseCodexConfig(text) {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

function officialConfigFailure(parsed) {
  return parsed.model_provider !== undefined || parsed.model_providers !== undefined
    ? 'codex_probe_config_profile_mismatch'
    : null;
}

function thirdPartyConfigFailure(profile, parsed) {
  if ((profile.wire_api || 'responses') !== 'responses') return 'codex_probe_unsupported_wire_api';
  const providerKey = providerConfigKey(profile.cc_switch_provider_id || profile.provider);
  const configuredKey = String(parsed.model_provider || '');
  const configured = parsed.model_providers?.[configuredKey];
  if (configuredKey !== providerKey || !configured || configured.wire_api !== 'responses')
    return 'codex_probe_config_profile_mismatch';
  const expectedBaseUrl = profile.kind === 'docker' ? containerizeLoopbackUrl(profile.base_url) : profile.base_url;
  if (normalizeUrl(configured.base_url) !== normalizeUrl(expectedBaseUrl)) return 'codex_probe_config_profile_mismatch';
  if (configured.requires_openai_auth !== (profile.requires_openai_auth === true))
    return 'codex_probe_config_profile_mismatch';
  return configured.env_key === 'OPENAI_API_KEY' ? null : 'codex_probe_config_profile_mismatch';
}

export function inspectCodexRuntime(profile, dockerInfo, imageInspect) {
  if (profile?.kind !== 'docker') return { ok: true, check: probeCheck('runtime') };
  if (!dockerInfo?.ok)
    return probeFailure(
      dockerInfo?.error_code === 'codex_probe_cli_missing'
        ? 'codex_probe_cli_missing'
        : 'codex_probe_docker_unavailable'
    );
  if (!imageInspect?.ok) {
    if (imageInspect?.error_code === 'codex_probe_docker_unavailable')
      return probeFailure('codex_probe_docker_unavailable');
    if (imageInspect?.error_code === 'codex_probe_image_inspection_failed')
      return probeFailure('codex_probe_image_inspection_failed');
    return probeFailure('codex_probe_image_missing');
  }
  return { ok: true, check: probeCheck('runtime') };
}

export function inspectCodexBinding(profile, auth) {
  if (!auth || auth.status !== 'authenticated') return probeFailure('codex_probe_auth_missing');
  const authProvider = normalizedProvider(auth.provider);
  const profileProvider = normalizedProvider(profile?.provider);
  if (!sameProvider(authProvider, profileProvider)) return probeFailure('codex_probe_auth_provider_mismatch');
  const failure = isThirdParty(profileProvider)
    ? thirdPartyBindingFailure(profile, auth)
    : officialBindingFailure(auth);
  return failure ? probeFailure(failure) : { ok: true, check: probeCheck('binding') };
}

function thirdPartyBindingFailure(profile, auth) {
  if (!normalizeUrl(profile?.base_url) || normalizeUrl(auth.base_url) !== normalizeUrl(profile.base_url))
    return 'codex_probe_auth_endpoint_mismatch';
  if ((profile.wire_api || 'responses') !== 'responses' || (auth.wire_api || 'responses') !== 'responses')
    return 'codex_probe_unsupported_wire_api';
  return auth.refs?.credential ? null : 'codex_probe_credential_unavailable';
}

function officialBindingFailure(auth) {
  if (auth.home || auth.refs?.auth_bundle) return null;
  return auth.refs?.credential ? null : 'codex_probe_credential_unavailable';
}

export function createCodexPreflight({ profile, auth, configText, dockerInfo, imageInspect }) {
  const checks = [];
  for (const inspection of [
    inspectCodexConfig(profile, configText),
    inspectCodexRuntime(profile, dockerInfo, imageInspect),
    inspectCodexBinding(profile, auth)
  ]) {
    if (!inspection.ok) return { ...inspection, checks: failedChecks(checks, inspection) };
    checks.push(inspection.check);
  }
  return { ok: true, phase: 'binding', checks };
}

export function classifyCodexExecution(processResult, { markerFound = false, diagnostic = '' } = {}) {
  const process = publicProcess(processResult);
  if (processResult?.ok && markerFound) return successfulExecution(process);
  const text = String(diagnostic || '')
    .slice(-16000)
    .toLowerCase();
  const failure = executionFailure(processResult, markerFound, text);
  if (failure) return { ...failure, process };
  return successfulExecution(process);
}

function executionFailure(processResult, markerFound, text) {
  if (processResult?.timed_out) return probeFailure('codex_probe_timeout');
  const diagnostic = diagnosticFailure(text);
  if (diagnostic) return diagnostic;
  if (processResult?.ok && !markerFound) return probeFailure('codex_probe_response_marker_missing');
  return processResult?.ok ? null : probeFailure('codex_probe_request_failed');
}

function diagnosticFailure(text) {
  for (const [pattern, resolution] of DIAGNOSTIC_FAILURE_RULES) {
    if (!pattern.test(text)) continue;
    const errorCode = typeof resolution === 'function' ? resolution(text) : resolution;
    return probeFailure(errorCode);
  }
  return null;
}

function forbiddenFailureCode(text) {
  return /model/.test(text) ? 'codex_probe_model_access_denied' : 'codex_probe_auth_rejected';
}

function successfulExecution(process) {
  return {
    ok: true,
    phase: 'inference',
    checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => probeCheck(phase)),
    process
  };
}

export function completeCodexProbe(preflight, execution) {
  if (!preflight?.ok) return preflight;
  if (!execution?.ok)
    return {
      ...execution,
      checks: failedChecks(preflight.checks || [], execution)
    };
  return {
    ok: true,
    phase: 'inference',
    summary: 'Codex 非写入探针已通过',
    checks: [...(preflight.checks || []), ...(execution.checks || [])],
    process: execution.process
  };
}

function failedChecks(preflightChecks, failure) {
  const existing = new Map(preflightChecks.map((item) => [item.phase, item]));
  const failedIndex = CODEX_PROBE_PHASES.indexOf(failure.phase);
  const uncertainInference =
    failure.phase === 'inference' && ['codex_probe_timeout', 'codex_probe_request_failed'].includes(failure.error_code);
  return CODEX_PROBE_PHASES.map((phase, index) => {
    if (uncertainInference && index > 2 && index < failedIndex) return probeCheck(phase, 'pending');
    if (index < failedIndex) return existing.get(phase) || probeCheck(phase, 'passed');
    if (index === failedIndex) return probeCheck(phase, 'failed', failure);
    return probeCheck(phase, 'pending');
  });
}
