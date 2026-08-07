import fs from 'node:fs';
import path from 'node:path';

export function composeYaml({ appImage, brokerImage, runnerImage, runnerDigest, volume, port, secretFile, codexSecretFile = process.env.AIWS_CODEX_SECRET_FILE || '', githubSecretFile = process.env.AIWS_GITHUB_SECRET_FILE || '', githubRepository = process.env.AIWS_GITHUB_REPOSITORY || '', githubFixtureSha = process.env.AIWS_GITHUB_FIXTURE_SHA || '', root = process.cwd() }) {
  const secret = secretFile.replaceAll('\\', '/');
  const codexPath = codexSecretFile ? path.resolve(root, codexSecretFile) : '';
  if (codexPath && !fs.existsSync(codexPath)) throw new Error('rehearsal_codex_secret_unreadable');
  const codexSecret = codexPath && fs.existsSync(codexPath) ? codexPath.replaceAll('\\', '/') : '';
  const codexEnvironment = codexSecret ? '\n      AIWS_CODEX_SECRET_FILE: /run/secrets/codex_api_key' : '';
  const codexServiceSecret = codexSecret ? '\n      - codex_api_key' : '';
  const codexSecretDefinition = codexSecret ? `\n  codex_api_key:\n    file: "${codexSecret}"` : '';
  const brokerExecutor = codexSecret ? 'docker' : 'mock';
  // Mock execution writes the mounted workspace in the Broker process. Keep it
  // root with the narrow filesystem capability needed to cross the 0700 volume
  // root; the real Docker executor remains capability-free.
  const brokerCapability = brokerExecutor === 'mock' ? '\n    cap_add:\n      - DAC_OVERRIDE' : '';
  const brokerSocket = brokerExecutor === 'docker' ? '\n      - /var/run/docker.sock:/var/run/docker.sock' : '';
  const githubPath = githubSecretFile ? path.resolve(root, githubSecretFile) : '';
  if (githubPath && !fs.existsSync(githubPath)) throw new Error('rehearsal_github_secret_unreadable');
  const githubSecret = githubPath && fs.existsSync(githubPath) ? githubPath.replaceAll('\\', '/') : '';
  const githubEnvironment = githubSecret ? `\n      AIWS_GITHUB_SECRET_FILE: /run/secrets/github_token\n      AIWS_GITHUB_REPOSITORY: ${githubRepository}\n      AIWS_GITHUB_FIXTURE_SHA: ${githubFixtureSha}` : '';
  const githubServiceSecret = githubSecret ? '\n      - github_token' : '';
  const githubSecretDefinition = githubSecret ? `\n  github_token:\n    file: "${githubSecret}"` : '';
  return `services:
  app:
    image: ${appImage}
    init: true
    read_only: true
    labels:
      aiws.owner: aiws-v3-release
      aiws.role: acceptance-app
    ports:
      - "127.0.0.1:${port}:4317"
    environment:
      NODE_ENV: production
      AIWS_HOME: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_BROKER_URL: http://runner-broker:4321
      AIWS_BROKER_MODE: http
      AIWS_RUNNER_DIGEST: ${runnerDigest}
      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}${codexEnvironment}${githubEnvironment}
    secrets:
      - broker_hmac${codexServiceSecret}${githubServiceSecret}
    volumes:
      - data:/var/lib/aiws
    tmpfs:
      - /tmp:size=256m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
    depends_on:
      - runner-broker
    networks:
      - internal
      - edge
  runner-broker:
    image: ${brokerImage}
    init: true
    read_only: true
    labels:
      aiws.owner: aiws-v3-release
      aiws.role: acceptance-broker
    environment:
      NODE_ENV: production
      AIWS_BROKER_EXECUTOR: ${brokerExecutor}
      AIWS_BROKER_DATA_ROOT: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}
      AIWS_RUNNER_DIGEST: ${runnerDigest}
      AIWS_RUNNER_IMAGE: ${runnerImage}
    secrets:
      - broker_hmac
    volumes:
${brokerSocket}
      - data:/var/lib/aiws
    tmpfs:
      - /tmp:size=256m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL${brokerCapability}
    networks:
      - internal
networks:
  internal:
    internal: true
  edge: {}
  model:
    name: aiws-runner-model
volumes:
  data:
    external: true
    name: ${volume}
secrets:
  broker_hmac:
    file: "${secret}"${codexSecretDefinition}${githubSecretDefinition}
`;
}
