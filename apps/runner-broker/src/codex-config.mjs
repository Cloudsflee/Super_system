// The legacy workspace route is fixed for the Runner. Only the model is supplied
// by the signed job spec and checked against AIWS_CODEX_MODEL by the Broker.
export const CODEX_BASE_URL = 'http://172.93.218.157:8080/v1';
export const CODEX_PROVIDER = 'custom';
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';

export function renderCodexConfig({ model = CODEX_DEFAULT_MODEL } = {}) {
  const selectedModel = String(model || CODEX_DEFAULT_MODEL);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedModel)) throw new Error('model_name_invalid');
  return [
    `model = ${JSON.stringify(selectedModel)}`,
    `model_provider = ${JSON.stringify(CODEX_PROVIDER)}`,
    '',
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = ${JSON.stringify(CODEX_PROVIDER)}`,
    `base_url = ${JSON.stringify(CODEX_BASE_URL)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
    ''
  ].join('\n');
}
