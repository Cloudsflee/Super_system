import { parse as parseToml } from 'smol-toml';
import { containerizeLoopbackUrl } from './codex-container-network.mjs';

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
  codex_probe_config_too_large: ['configuration', 'Codex 配置文件超出允许大小', '移除异常配置内容并重新保存 Profile。', false],
  codex_probe_config_invalid: ['configuration', 'Codex 配置语法无效', '重新保存 Profile，让系统重建 config.toml。', false],
  codex_probe_config_profile_mismatch: ['configuration', '磁盘配置与当前 Profile 不一致', '重新保存或导入 Profile，不要手工复制旧 config.toml。', false],
  codex_probe_unsupported_wire_api: ['configuration', '当前 Provider 不是 Responses 协议', '选择支持 Responses API 的 Endpoint，或启用完整的协议转换代理。', false],
  codex_probe_cc_switch_not_ready: ['configuration', 'cc-switch Runtime Bridge 未就绪', '先同步 cc-switch 并确认当前 Profile 的 Provider 映射为已同步。', true],
  codex_probe_docker_unavailable: ['runtime', 'Docker 引擎当前不可用', '启动 Docker Desktop，确认已切换到 Linux containers，然后重试。', true],
  codex_probe_image_missing: ['runtime', 'Codex 隔离镜像不存在', '重新部署 aiws-codex-runner:1.4.0-codex-0.144.0。', true],
  codex_probe_image_inspection_failed: ['runtime', 'Codex 隔离镜像状态无法确认', '检查 Docker 权限与引擎状态，然后重新检测。', true],
  codex_probe_mount_unavailable: ['runtime', 'Profile 的隔离挂载不可用', '检查工作区路径和 Docker Desktop 文件共享权限。', false],
  codex_probe_cli_missing: ['runtime', 'Codex CLI 无法启动', '重建 Codex 镜像，或检查本机 codex 命令是否可用。', false],
  codex_probe_auth_missing: ['binding', 'Codex 凭据不存在或已失效', '重新选择官方账户登录、cc-switch、本地 Codex 配置或 API Key。', false],
  codex_probe_auth_provider_mismatch: ['binding', '凭据 Provider 与 Profile 不匹配', '重新导入同一 Provider 的凭据与 Profile。', false],
  codex_probe_auth_endpoint_mismatch: ['binding', '凭据 Endpoint 与 Profile 不匹配', '使用同一个 Base URL 重新认证并保存 Profile。', false],
  codex_probe_credential_unavailable: ['binding', '凭据引用无法读取', '重新登录或导入配置，以恢复本地 Vault 凭据。', false],
  codex_probe_endpoint_dns_failed: ['transport', 'Endpoint 域名无法解析', '检查 DNS、代理与 Base URL 的域名。', true],
  codex_probe_endpoint_tls_failed: ['transport', 'Endpoint TLS 校验失败', '检查证书链、系统时间与 HTTPS 代理。', false],
  codex_probe_endpoint_unreachable: ['transport', 'Endpoint 网络不可达', '检查 Base URL、防火墙、代理和容器网络。', true],
  codex_probe_endpoint_timeout: ['transport', 'Endpoint 连接超时', '检查 Endpoint 和代理后重试；必要时增加 Profile 超时时间。', true],
  codex_probe_timeout: ['inference', 'Codex 探针在限定时间内未完成', '重试后检查 Endpoint 延迟、MCP 启动和 Profile 超时时间。', true],
  codex_probe_configuration_changed: ['configuration', 'Probe 执行期间配置发生变化', '重新运行 Probe，以校验当前最新配置。', true],
  codex_probe_auth_rejected: ['binding', 'Endpoint 拒绝了当前凭据', '确认 API Key / 官方账户仍有效，且属于当前 Endpoint。', false],
  codex_probe_responses_route_not_found: ['protocol', 'Endpoint 未提供 Responses API', '确认 Base URL 后可正确访问 /responses，不要填写仅支持 Chat Completions 的地址。', false],
  codex_probe_protocol_rejected: ['protocol', 'Endpoint 返回了不兼容的 Responses 协议内容', '检查第三方 API 的 Responses 兼容性与代理配置。', false],
  codex_probe_model_not_found: ['model', 'Endpoint 不识别当前模型', '从 Provider 可用模型列表中选择正确的 Model ID。', false],
  codex_probe_model_access_denied: ['model', '当前凭据无权访问该模型', '更换有模型权限的凭据，或改用已授权的 Model ID。', false],
  codex_probe_rate_limited: ['protocol', 'Endpoint 当前限流或额度不足', '稍后重试，或检查 Provider 额度和限流策略。', true],
  codex_probe_upstream_unavailable: ['protocol', 'Provider 服务暂时不可用', '稍后重试，并检查 Provider 状态。', true],
  codex_probe_response_marker_missing: ['inference', 'Codex 请求完成，但未返回校验标记', '重试 Probe；若持续出现，检查模型是否能正常返回 agent_message。', true],
  codex_probe_request_failed: ['inference', 'Codex 真实请求失败', '根据上方已通过和失败的检查项修复配置后重试。', true]
});

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
  if (failure?.error_code) Object.assign(check, {
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
  let parsed;
  try { parsed = parseToml(text); }
  catch { return probeFailure('codex_probe_config_invalid'); }
  if (!profile?.model || String(parsed.model || '') !== String(profile.model)) return probeFailure('codex_probe_config_profile_mismatch');
  if (!isThirdParty(profile?.provider)) {
    if (parsed.model_provider !== undefined || parsed.model_providers !== undefined) return probeFailure('codex_probe_config_profile_mismatch');
    return { ok: true, check: probeCheck('configuration') };
  }
  if ((profile.wire_api || 'responses') !== 'responses') return probeFailure('codex_probe_unsupported_wire_api');
  const providerKey = providerConfigKey(profile.cc_switch_provider_id || profile.provider);
  const configuredKey = String(parsed.model_provider || '');
  const configured = parsed.model_providers?.[configuredKey];
  if (configuredKey !== providerKey || !configured || configured.wire_api !== 'responses') return probeFailure('codex_probe_config_profile_mismatch');
  const expectedBaseUrl = profile.kind === 'docker' ? containerizeLoopbackUrl(profile.base_url) : profile.base_url;
  if (normalizeUrl(configured.base_url) !== normalizeUrl(expectedBaseUrl)) return probeFailure('codex_probe_config_profile_mismatch');
  if (configured.requires_openai_auth !== (profile.requires_openai_auth === true)) return probeFailure('codex_probe_config_profile_mismatch');
  if (configured.env_key !== 'OPENAI_API_KEY') return probeFailure('codex_probe_config_profile_mismatch');
  return { ok: true, check: probeCheck('configuration') };
}

export function inspectCodexRuntime(profile, dockerInfo, imageInspect) {
  if (profile?.kind !== 'docker') return { ok: true, check: probeCheck('runtime') };
  if (!dockerInfo?.ok) return probeFailure(dockerInfo?.error_code === 'codex_probe_cli_missing' ? 'codex_probe_cli_missing' : 'codex_probe_docker_unavailable');
  if (!imageInspect?.ok) {
    if (imageInspect?.error_code === 'codex_probe_docker_unavailable') return probeFailure('codex_probe_docker_unavailable');
    if (imageInspect?.error_code === 'codex_probe_image_inspection_failed') return probeFailure('codex_probe_image_inspection_failed');
    return probeFailure('codex_probe_image_missing');
  }
  return { ok: true, check: probeCheck('runtime') };
}

export function inspectCodexBinding(profile, auth) {
  if (!auth || auth.status !== 'authenticated') return probeFailure('codex_probe_auth_missing');
  const authProvider = String(auth.provider || '').trim().toLowerCase();
  const profileProvider = String(profile?.provider || '').trim().toLowerCase();
  if (!sameProvider(authProvider, profileProvider)) return probeFailure('codex_probe_auth_provider_mismatch');
  if (isThirdParty(profileProvider)) {
    if (!normalizeUrl(profile?.base_url) || normalizeUrl(auth.base_url) !== normalizeUrl(profile.base_url)) return probeFailure('codex_probe_auth_endpoint_mismatch');
    if ((profile.wire_api || 'responses') !== 'responses' || (auth.wire_api || 'responses') !== 'responses') return probeFailure('codex_probe_unsupported_wire_api');
    if (!auth.refs?.credential) return probeFailure('codex_probe_credential_unavailable');
  } else if (auth.home || auth.refs?.auth_bundle) {
    if (!auth.refs?.auth_bundle && !auth.home) return probeFailure('codex_probe_credential_unavailable');
  } else if (!auth.refs?.credential) return probeFailure('codex_probe_credential_unavailable');
  return { ok: true, check: probeCheck('binding') };
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
  if (processResult?.ok && markerFound) return { ok: true, phase: 'inference', checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => probeCheck(phase)), process };
  const text = String(diagnostic || '').slice(-16000).toLowerCase();
  let failure;
  if (processResult?.timed_out) failure = probeFailure('codex_probe_timeout');
  else if (/\b(?:connect(?:ion)?|request|operation)[^\n]{0,80}(?:timed? out|timeout)\b|\b(?:timed? out|timeout)[^\n]{0,80}(?:connect(?:ion)?|request|operation)\b/.test(text)) failure = probeFailure('codex_probe_endpoint_timeout');
  else if (/dockerdesktoplinuxengine|docker daemon|docker api|cannot connect to (?:the )?docker|is the docker daemon running|\\\\\.\\pipe\\docker/.test(text)) failure = probeFailure('codex_probe_docker_unavailable');
  else if (/unable to find image|no such image|pull access denied/.test(text)) failure = probeFailure('codex_probe_image_missing');
  else if (/invalid mount config|mount denied|drive is not shared|bind source path does not exist/.test(text)) failure = probeFailure('codex_probe_mount_unavailable');
  else if (/enoent|not recognized as an internal|command not found|executable file not found/.test(text)) failure = probeFailure('codex_probe_cli_missing');
  else if (/toml parse error|failed to parse.*config|invalid configuration|unknown variant.*wire_api/.test(text)) failure = probeFailure('codex_probe_config_invalid');
  else if (/model[_ -]?not[_ -]?found|unknown model|model .* does not exist|404[^\n]{0,160}\bmodel\b|\bmodel\b[^\n]{0,160}404/.test(text)) failure = probeFailure('codex_probe_model_not_found');
  else if (/does not have access to model|model access (?:denied|forbidden)|not authorized (?:to use|for).*model/.test(text)) failure = probeFailure('codex_probe_model_access_denied');
  else if (/401|unauthorized|invalid api key|incorrect api key|authentication failed|invalid[_ -]?token|token.*expired/.test(text)) failure = probeFailure('codex_probe_auth_rejected');
  else if (/403|forbidden|permission denied/.test(text)) failure = /model/.test(text) ? probeFailure('codex_probe_model_access_denied') : probeFailure('codex_probe_auth_rejected');
  else if (/enotfound|eai_again|dns error|failed to lookup address|name or service not known|no such host/.test(text)) failure = probeFailure('codex_probe_endpoint_dns_failed');
  else if (/certificate|unknown issuer|self[- ]signed|tls|ssl|invalid peer certificate/.test(text)) failure = probeFailure('codex_probe_endpoint_tls_failed');
  else if (/econnrefused|econnreset|network is unreachable|connection refused|connection reset|error sending request|failed to connect/.test(text)) failure = probeFailure('codex_probe_endpoint_unreachable');
  else if (/404|method not allowed|405/.test(text) && /responses|endpoint|route|url/.test(text)) failure = probeFailure('codex_probe_responses_route_not_found');
  else if (/429|too many requests|rate.?limit|insufficient_quota|quota exceeded/.test(text)) failure = probeFailure('codex_probe_rate_limited');
  else if (/\b(?:500|502|503|504)\b|bad gateway|service unavailable|gateway timeout|upstream/.test(text)) failure = probeFailure('codex_probe_upstream_unavailable');
  else if (/invalid response|unexpected response|failed to deserialize|decode.*response|responses api/.test(text)) failure = probeFailure('codex_probe_protocol_rejected');
  else if (processResult?.ok && !markerFound) failure = probeFailure('codex_probe_response_marker_missing');
  else if (!processResult?.ok) failure = probeFailure('codex_probe_request_failed');
  if (failure) return { ...failure, process };
  return { ok: true, phase: 'inference', checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => probeCheck(phase)), process };
}

export function completeCodexProbe(preflight, execution) {
  if (!preflight?.ok) return preflight;
  if (!execution?.ok) return {
    ...execution,
    checks: failedChecks(preflight.checks || [], execution)
  };
  return { ok: true, phase: 'inference', summary: 'Codex 非写入探针已通过', checks: [...(preflight.checks || []), ...(execution.checks || [])], process: execution.process };
}

function failedChecks(preflightChecks, failure) {
  const existing = new Map(preflightChecks.map((item) => [item.phase, item]));
  const failedIndex = CODEX_PROBE_PHASES.indexOf(failure.phase);
  const uncertainInference = failure.phase === 'inference' && ['codex_probe_timeout', 'codex_probe_request_failed'].includes(failure.error_code);
  return CODEX_PROBE_PHASES.map((phase, index) => {
    if (uncertainInference && index > 2 && index < failedIndex) return probeCheck(phase, 'pending');
    if (index < failedIndex) return existing.get(phase) || probeCheck(phase, 'passed');
    if (index === failedIndex) return probeCheck(phase, 'failed', failure);
    return probeCheck(phase, 'pending');
  });
}
function publicProcess(value) { return { exit_code: Number.isInteger(value?.code) ? value.code : null, timed_out: value?.timed_out === true }; }
function publicOverrides(value) {
  const allowed = {};
  if (Array.isArray(value.checks)) allowed.checks = value.checks;
  if (value.process) allowed.process = publicProcess(value.process);
  return allowed;
}
function providerConfigKey(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'custom'; }
function normalizeUrl(value) { try { const url = new URL(String(value || '').trim()); return url.href.replace(/\/$/, ''); } catch { return null; } }
function isThirdParty(value) { return !['openai', 'chatgpt'].includes(String(value || 'openai').trim().toLowerCase()); }
function sameProvider(left, right) { return left === right || (!isThirdParty(left) && !isThirdParty(right)); }
