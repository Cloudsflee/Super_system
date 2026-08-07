import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SOURCE_VOLUME = 'aiws-data-v23';
const INSTANCE = 'aiws-v23';
const EVIDENCE_IMAGE = process.env.AIWS_EVIDENCE_IMAGE || 'docker.m.daocloud.io/library/node:24.14.0-alpine3.22';
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const cloneVolume = `${SOURCE_VOLUME}-cold-${stamp}`;
const recoveryVolume = `${SOURCE_VOLUME}-recovery-${stamp}`;
const root = process.cwd();
const releaseDir = path.join(root, '.ai-workspace', 'release', 'v3-transition');
const archiveDir = path.join(root, '.ai-workspace', 'archives');
const archiveName = `${cloneVolume}.tar.gz`;
const archivePath = path.join(archiveDir, archiveName);
const legacyReceiptPath = path.join(root, '.ai-workspace', 'release', 'v23-cutover-latest.json');

fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(archiveDir, { recursive: true });

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024
  }).trim();
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function inspect(name, kind = 'object') {
  const command = kind === 'image' ? ['image', 'inspect', name] : ['inspect', name];
  try {
    return JSON.parse(docker(command))[0];
  } catch {
    return null;
  }
}

function writeReceipt(name, body) {
  const unsigned = JSON.stringify(body, null, 2);
  const receipt = { ...body, receipt_sha256: sha256Bytes(unsigned) };
  const target = path.join(releaseDir, name);
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444);
  return { path: target, sha256: sha256File(target), receipt };
}

const inspectScript = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const { DatabaseSync } = require('node:sqlite');
  const root = '/evidence';
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  files.sort();
  const manifest = files.map((file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    size: fs.statSync(file).size,
    sha256: execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(/\s+/)[0]
  }));
  const databases = [];
  for (const file of files.filter((item) => item.endsWith('.sqlite'))) {
    const scratch = '/tmp/database-' + databases.length + '.sqlite';
    try {
      fs.copyFileSync(file, scratch);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, scratch + suffix);
      }
      const db = new DatabaseSync(scratch);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const tableCounts = {};
      for (const row of tables) {
        const escaped = String(row.name).replaceAll('"', '""');
        tableCounts[row.name] = Number(db.prepare('SELECT count(*) AS count FROM "' + escaped + '"').get().count);
      }
      databases.push({
        path: path.relative(root, file).split(path.sep).join('/'),
        user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
        integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check),
        journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        table_counts: tableCounts
      });
      db.close();
    } catch (error) {
      databases.push({ path: path.relative(root, file), error: error.message });
    } finally {
      for (const candidate of [scratch, scratch + '-wal', scratch + '-shm']) {
        if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
      }
    }
  }
  const summary = {
    file_count: manifest.length,
    byte_count: manifest.reduce((sum, item) => sum + item.size, 0),
    manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    files: manifest,
    databases
  };
  process.stdout.write(JSON.stringify(summary));
`;

function inspectVolume(volume) {
  return JSON.parse(
    docker([
      'run', '--rm', '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:size=1g,mode=1777',
      '--mount', `type=volume,src=${volume},dst=/evidence,readonly`,
      EVIDENCE_IMAGE, 'node', '--disable-warning=ExperimentalWarning', '-e', inspectScript
    ])
  );
}

const sourceVolume = inspect(SOURCE_VOLUME);
if (!sourceVolume) throw new Error(`missing source volume: ${SOURCE_VOLUME}`);

const running = docker(['ps', '-q', '--filter', `volume=${SOURCE_VOLUME}`]);
if (running) throw new Error(`source volume is still mounted by running container: ${running}`);

const allSourceContainers = docker(['ps', '-aq', '--filter', `volume=${SOURCE_VOLUME}`])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((id) => inspect(id));
const appContainer = allSourceContainers.find((item) => item?.Config?.Labels?.['com.docker.compose.project'] === INSTANCE);
const appImageName = appContainer?.Config?.Image ?? 'aiws-app:2.3.0';
const appImage = inspect(appImageName, 'image');
const runnerImageName = appContainer?.Config?.Env
  ?.find((entry) => entry.startsWith('AIWS_CODEX_DOCKER_IMAGE='))
  ?.slice('AIWS_CODEX_DOCKER_IMAGE='.length) ?? 'aiws-codex-runner:2.3.0-codex-0.144.0';
const runnerImage = inspect(runnerImageName, 'image');
const legacyReceiptBytes = fs.readFileSync(legacyReceiptPath);
const legacyReceipt = JSON.parse(legacyReceiptBytes);
const rollbackImage = inspect(legacyReceipt.rollback_image, 'image');

const existingRevocationPath = fs.readdirSync(releaseDir)
  .filter((name) => /^v23-revocation-\d+\.json$/.test(name))
  .sort()
  .map((name) => path.join(releaseDir, name))
  .at(-1);
const revocation = existingRevocationPath
  ? {
      path: existingRevocationPath,
      sha256: sha256File(existingRevocationPath),
      receipt: JSON.parse(fs.readFileSync(existingRevocationPath, 'utf8'))
    }
  : writeReceipt(`v23-revocation-${stamp}.json`, {
  schema_version: 'aiws.release_receipt_revocation.v1',
  product_version: '2.3.0',
  status: 'revoked',
  created_at: startedAt.toISOString(),
  immutable_source_receipt: {
    path: path.relative(root, legacyReceiptPath).split(path.sep).join('/'),
    sha256: sha256Bytes(legacyReceiptBytes),
    original_status: legacyReceipt.status,
    original_completed_at: legacyReceipt.completed_at
  },
  reasons: [
    'declared rollback image tag is absent',
    'running image identifies a later source revision than the accepted receipt',
    'running image declares a non-clean working tree identity'
  ],
  declared_rollback: {
    image: legacyReceipt.rollback_image,
    present: Boolean(rollbackImage),
    digest: rollbackImage?.Id ?? null
  },
  observed_runtime: {
    container_id: appContainer?.Id ?? null,
    container_status: appContainer?.State?.Status ?? null,
    stopped_at: appContainer?.State?.FinishedAt ?? null,
    exit_code: appContainer?.State?.ExitCode ?? null,
    image: appImageName,
    image_digest: appImage?.Id ?? null,
    image_revision: appImage?.Config?.Labels?.['org.opencontainers.image.revision'] ?? null,
    source_tree: appImage?.Config?.Labels?.['aiws.source_tree'] ?? null,
    runner_image: runnerImageName,
    runner_digest: runnerImage?.Id ?? null
  },
  current_source: {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    clean: git(['status', '--porcelain=v1']) === ''
  }
    });

docker([
  'volume', 'create',
  '--label', 'aiws.owner=aiws-v3',
  '--label', 'aiws.role=cold-evidence',
  '--label', `aiws.source=${SOURCE_VOLUME}`,
  '--label', 'aiws.mount-policy=readonly',
  cloneVolume
]);

docker([
  'run', '--rm', '--network', 'none', '--read-only',
  '--mount', `type=volume,src=${SOURCE_VOLUME},dst=/source,readonly`,
  '--mount', `type=volume,src=${cloneVolume},dst=/target`,
  EVIDENCE_IMAGE, 'sh', '-lc', 'cp -a /source/. /target/'
]);

const sourceManifest = inspectVolume(SOURCE_VOLUME);
const cloneManifest = inspectVolume(cloneVolume);
if (sourceManifest.manifest_sha256 !== cloneManifest.manifest_sha256) {
  throw new Error('cold clone manifest does not match source volume');
}
assertPrimaryDatabase(cloneManifest, 'cold clone');

docker([
  'run', '--rm', '--network', 'none', '--read-only',
  '--mount', `type=volume,src=${cloneVolume},dst=/source,readonly`,
  '--mount', `type=bind,src=${archiveDir},dst=/out`,
  EVIDENCE_IMAGE, 'sh', '-lc', `tar -czf /out/${archiveName} -C /source .`
]);

docker([
  'volume', 'create',
  '--label', 'aiws.owner=aiws-v3',
  '--label', 'aiws.role=temporary-recovery-drill',
  recoveryVolume
]);

let recoveryManifest;
try {
  docker([
    'run', '--rm', '--network', 'none', '--read-only',
    '--mount', `type=volume,src=${recoveryVolume},dst=/target`,
    '--mount', `type=bind,src=${archiveDir},dst=/archive,readonly`,
    EVIDENCE_IMAGE, 'sh', '-lc', `tar -xzf /archive/${archiveName} -C /target`
  ]);
  recoveryManifest = inspectVolume(recoveryVolume);
  if (recoveryManifest.manifest_sha256 !== sourceManifest.manifest_sha256) {
    throw new Error('recovery drill manifest does not match source volume');
  }
  assertPrimaryDatabase(recoveryManifest, 'recovery drill');
} finally {
  docker(['volume', 'rm', recoveryVolume]);
}

const archiveReceipt = writeReceipt(`v23-cold-archive-${stamp}.json`, {
  schema_version: 'aiws.cold_archive_receipt.v1',
  product_version: '2.3.0',
  status: 'verified',
  created_at: new Date().toISOString(),
  source: {
    volume: SOURCE_VOLUME,
    labels: sourceVolume.Labels,
    running_mounts: 0,
    manifest: sourceManifest
  },
  cold_clone: {
    volume: cloneVolume,
    labels: inspect(cloneVolume)?.Labels ?? {},
    mount_policy: 'readonly',
    manifest_sha256: cloneManifest.manifest_sha256
  },
  archive: {
    path: path.relative(root, archivePath).split(path.sep).join('/'),
    bytes: fs.statSync(archivePath).size,
    sha256: sha256File(archivePath)
  },
  recovery_drill: {
    status: 'passed',
    temporary_volume: recoveryVolume,
    removed_after_validation: inspect(recoveryVolume) === null,
    manifest_sha256: recoveryManifest.manifest_sha256,
    databases: recoveryManifest.databases
  },
  source_identity: {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}'])
  },
  revocation_receipt: {
    path: path.relative(root, revocation.path).split(path.sep).join('/'),
    sha256: revocation.sha256
  },
  v3_mount_prohibition: [SOURCE_VOLUME, cloneVolume]
});

process.stdout.write(`${JSON.stringify({
  revocation_receipt: revocation.path,
  archive_receipt: archiveReceipt.path,
  archive: archivePath,
  clone_volume: cloneVolume,
  source_manifest_sha256: sourceManifest.manifest_sha256,
  recovery_manifest_sha256: recoveryManifest.manifest_sha256
}, null, 2)}\n`);

function assertPrimaryDatabase(manifest, stage) {
  const database = manifest.databases.find((item) => item.path === 'data/state-v23.sqlite');
  if (!database || database.error || !database.integrity?.every((item) => item === 'ok')) {
    throw new Error(`${stage} primary SQLite integrity check failed: ${JSON.stringify(database ?? null)}`);
  }
}
