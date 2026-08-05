import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { API_PREFIX, DEVELOPMENT_RUNNER_DIGEST, PRODUCT_VERSION } from '../../../packages/contracts/src/index.mjs';

export function loadConfig(env = process.env) {
  const home = path.resolve(env.AIWS_HOME || path.join(process.cwd(), '.ai-workspace', 'v3'));
  const dataVolume = env.AIWS_DOCKER_DATA_VOLUME || 'aiws-data-v3';
  if (/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume)) {
    throw new Error('legacy_data_volume_forbidden');
  }
  const production = env.NODE_ENV === 'production';
  const brokerMode = env.AIWS_BROKER_MODE || (env.AIWS_BROKER_HMAC_SECRET ? 'http' : 'mock');
  const brokerSecret = readSecret(env.AIWS_BROKER_HMAC_SECRET_FILE) || env.AIWS_BROKER_HMAC_SECRET || (production ? '' : 'dev-only-local-broker-secret');
  const runnerDigest = env.AIWS_RUNNER_DIGEST || (production ? '' : DEVELOPMENT_RUNNER_DIGEST);
  if (!/^sha256:[a-f0-9]{64}$/.test(runnerDigest) || /^sha256:0{64}$/.test(runnerDigest)) throw new Error('runner_digest_required');
  if (production && brokerSecret.length < 32) throw new Error('broker_hmac_secret_required');
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
    codexAvailable: env.AIWS_CODEX_AVAILABLE === '1',
    githubAvailable: env.AIWS_GITHUB_AVAILABLE === '1',
    cpuCount: os.cpus().length
  };
}

function readSecret(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}
