import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { API_PREFIX, DEVELOPMENT_RUNNER_DIGEST, PRODUCT_VERSION } from '../../../packages/contracts/src/index.mjs';

export function loadConfig(env = process.env) {
  const home = path.resolve(env.AIWS_HOME || path.join(process.cwd(), '.ai-workspace', 'v3'));
  const dataVolume = env.AIWS_DOCKER_DATA_VOLUME || 'aiws-data-v3';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dataVolume)) throw new Error('data_volume_name_invalid');
  if (/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume)) {
    throw new Error('legacy_data_volume_forbidden');
  }
  const production = env.NODE_ENV === 'production';
  const brokerMode = env.AIWS_BROKER_MODE || (env.AIWS_BROKER_HMAC_SECRET ? 'http' : 'mock');
  const brokerSecret = readSecret(env.AIWS_BROKER_HMAC_SECRET_FILE) || env.AIWS_BROKER_HMAC_SECRET || (production ? '' : 'dev-only-local-broker-secret');
  const runnerDigest = env.AIWS_RUNNER_DIGEST || (production ? '' : DEVELOPMENT_RUNNER_DIGEST);
  if (!/^sha256:[a-f0-9]{64}$/.test(runnerDigest) || /^sha256:0{64}$/.test(runnerDigest)) throw new Error('runner_digest_required');
  if (production && brokerSecret.length < 32) throw new Error('broker_hmac_secret_required');
  const codexModel = env.AIWS_CODEX_MODEL || 'gpt-5.5';
  // A configured Secret Bundle is an explicit startup contract in every mode.
  // Development remains credential-free when the file is omitted.
  const codexCredential = readCodexCredential(env.AIWS_CODEX_SECRET_FILE, { strict: true, model: codexModel });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(codexModel)) throw new Error('model_name_invalid');
  const githubCredential = readGithubCredential(env.AIWS_GITHUB_SECRET_FILE, { strict: true });
  const githubRepository = env.AIWS_GITHUB_REPOSITORY || '';
  if (githubRepository && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(githubRepository)) throw new Error('github_repository_invalid');
  const githubFixtureSha = env.AIWS_GITHUB_FIXTURE_SHA || '';
  if (githubFixtureSha && !/^[a-f0-9]{40}$/.test(githubFixtureSha)) throw new Error('github_fixture_sha_invalid');
  return {
    version: PRODUCT_VERSION,
    apiPrefix: API_PREFIX,
    host: env.AIWS_BIND_HOST || env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4317),
    home,
    databaseFile: path.join(home, 'data', 'state.sqlite'),
    casRoot: path.join(home, 'cas', 'sha256'),
    dataVolume,
    brokerUrl: env.AIWS_BROKER_URL || 'http://127.0.0.1:4321',
    brokerMode,
    brokerSecret,
    runnerDigest,
    codexModel,
    codexCredential,
    githubCredential,
    githubRepository,
    githubFixtureSha,
    cpuCount: os.cpus().length
  };
}

function readSecret(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readCodexCredential(file, { strict = false, model: configuredModel = 'gpt-5.5' } = {}) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); }
  catch (error) { throw new Error('codex_secret_unreadable'); }
  if (!raw) throw new Error('codex_secret_invalid');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { auth: raw }; }
  const auth = String(parsed.auth || parsed.api_key || parsed.apiKey || '').trim();
  const profile = String(parsed.profile || 'default').trim();
  const provider = String(parsed.provider || 'openai').trim();
  const modelProvided = parsed.model != null;
  const bundleModel = modelProvided ? String(parsed.model).trim() : null;
  const valid = /^\S{8,16384}$/.test(auth) && /^[A-Za-z0-9_-]{1,80}$/.test(profile) && provider === 'openai' && (!modelProvided || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bundleModel)) && (!modelProvided || bundleModel === configuredModel);
  if (!valid) {
    if (modelProvided && bundleModel !== configuredModel) throw new Error('codex_model_mismatch');
    if (provider !== 'openai' || !/^\S{8,16384}$/.test(auth)) { if (strict) throw new Error('codex_secret_invalid'); return null; }
    if (strict) throw new Error('codex_secret_invalid');
    return null;
  }
  return Object.freeze({ ref: 'cred_codex_default', profile, provider, model: bundleModel, auth });
}

function readGithubCredential(file, { strict = false } = {}) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); }
  catch { if (strict) throw new Error('github_secret_unreadable'); return null; }
  if (!/^\S{8,4096}$/.test(raw)) { if (strict) throw new Error('github_secret_invalid'); return null; }
  return Object.freeze({ ref: 'cred_github_default', token: raw });
}
