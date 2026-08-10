export const CODEX_DEFAULT_MODEL = 'gpt-5.5';

export function renderCodexConfig({
  model = CODEX_DEFAULT_MODEL,
  provider = 'openai',
  baseUrl = '',
  wireApi = 'responses',
  reasoning = 'medium'
} = {}) {
  const selectedModel = String(model || CODEX_DEFAULT_MODEL);
  const selectedProvider = String(provider || 'openai');
  const selectedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  const selectedWireApi = String(wireApi || 'responses');
  const selectedReasoning = String(reasoning || 'medium');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedModel)) throw new Error('model_name_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selectedProvider)) throw new Error('provider_name_invalid');
  if (!['responses', 'chat'].includes(selectedWireApi)) throw new Error('wire_api_invalid');
  if (!['low', 'medium', 'high'].includes(selectedReasoning)) throw new Error('reasoning_invalid');
  if (selectedBaseUrl) {
    const url = new URL(selectedBaseUrl);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error('base_url_invalid');
  }
  const lines = [
    `model = ${JSON.stringify(selectedModel)}`,
    `model_provider = ${JSON.stringify(selectedProvider)}`,
    `model_reasoning_effort = ${JSON.stringify(selectedReasoning)}`,
    ''
  ];
  if (selectedProvider !== 'openai' || selectedBaseUrl) {
    lines.push(
      `[model_providers.${selectedProvider}]`,
      `name = ${JSON.stringify(selectedProvider)}`,
      `base_url = ${JSON.stringify(selectedBaseUrl)}`,
      `wire_api = ${JSON.stringify(selectedWireApi)}`,
      'requires_openai_auth = false',
      'env_key = "OPENAI_API_KEY"',
      ''
    );
  }
  return lines.join('\n');
}
