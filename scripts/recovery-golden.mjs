import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualityReviewMediaKind as v3QualityReviewMediaKind } from '../apps/api/src/modules/quality/media-contract.mjs';

const root = process.cwd();
const mode = process.argv[2] || 'verify';
const sourceCommit = 'e18dc0b';
const fixturePath = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
const mediaCases = Object.freeze([
  { id: 'markdown', input: { file_path: 'notes.md', media_type: 'text/markdown', has_body: true } },
  { id: 'json', input: { file_path: 'data.json', media_type: 'application/json', has_body: true } },
  { id: 'svg', input: { file_path: 'diagram.svg', media_type: 'image/svg+xml', has_body: true } },
  { id: 'png', input: { file_path: 'image.png', media_type: 'image/png', has_body: true } },
  { id: 'pdf', input: { file_path: 'report.pdf', media_type: 'application/pdf', has_body: true } },
  { id: 'docx', input: { file_path: 'document.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', has_body: true } },
  { id: 'xlsx', input: { file_path: 'workbook.xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', has_body: true } },
  { id: 'pptx-excluded', input: { file_path: 'slides.pptx', media_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', has_body: true } },
  { id: 'video-excluded', input: { file_path: 'clip.mp4', media_type: 'video/mp4', has_body: true } },
  { id: 'archive-excluded', input: { file_path: 'bundle.zip', media_type: 'application/octet-stream', has_body: true } },
  { id: 'generic-body', input: { file_path: 'unknown.bin', media_type: 'application/octet-stream', has_body: true } },
  { id: 'generic-probe', input: { file_path: 'unknown.bin', media_type: 'application/octet-stream', has_body: false } }
]);

if (mode === 'extract') await extract();
else if (mode === 'verify') verify();
else throw new Error(`unknown_golden_mode:${mode}`);

async function extract() {
  const worktree = path.join(os.tmpdir(), `aiws-v23-golden-${process.pid}-${randomUUID()}`);
  const sourcePath = 'apps/api/src/quality-review-media.mjs';
  runGit(['worktree', 'add', '--detach', worktree, sourceCommit]);
  try {
    const resolvedCommit = runGit(['-C', worktree, 'rev-parse', 'HEAD']).stdout.trim();
    if (resolvedCommit !== runGit(['rev-parse', sourceCommit]).stdout.trim()) throw new Error('golden_source_commit_mismatch');
    const before = runGit(['-C', worktree, 'status', '--porcelain']).stdout;
    if (before) throw new Error('golden_worktree_not_clean');
    const sourceFile = path.join(worktree, sourcePath);
    const sourceSha256 = sha256(fs.readFileSync(sourceFile));
    const source = await import(`${pathToFileURL(sourceFile).href}?golden=${randomUUID()}`);
    const cases = mediaCases.map(({ id, input }) => ({
      id,
      input,
      output: source.qualityReviewMediaKind(input.file_path, input.media_type, { hasBody: input.has_body })
    }));
    const after = runGit(['-C', worktree, 'status', '--porcelain']).stdout;
    if (after) throw new Error('golden_source_worktree_modified');
    const payload = {
      schema_version: 'aiws.v3.v23_golden.v1',
      source_commit: sourceCommit,
      extraction: { mode: 'detached_read_only_worktree', executed_runtime: false },
      source_files: [{ path: sourcePath, sha256: sourceSha256 }],
      contracts: [{
        id: 'quality-media-classification',
        feature_id: 'REC-D9-QUALITY-020',
        cases
      }]
    };
    const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'extracted', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, cases: cases.length }, null, 2)}\n`);
  } finally {
    const removed = spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (removed.status !== 0) fs.rmSync(worktree, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8', windowsHide: true });
  }
}

function verify() {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.v23_golden.v1' || fixture.source_commit !== sourceCommit) throw new Error('golden_fixture_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('golden_fixture_checksum_invalid');
  if (fixture.extraction?.mode !== 'detached_read_only_worktree' || fixture.extraction?.executed_runtime !== false) throw new Error('golden_extraction_policy_invalid');
  const contract = fixture.contracts.find((item) => item.id === 'quality-media-classification');
  if (!contract?.cases?.length) throw new Error('golden_contract_missing');
  const failures = contract.cases.filter((item) => v3QualityReviewMediaKind(item.input.file_path, item.input.media_type, { hasBody: item.input.has_body }) !== item.output);
  if (failures.length) throw new Error(`golden_behavior_mismatch:${failures.map((item) => item.id).join(',')}`);
  process.stdout.write(`${JSON.stringify({ status: 'passed', fixture: relative(fixturePath), fixture_sha256: recorded, cases: contract.cases.length }, null, 2)}\n`);
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`golden_git_failed:${args.join(' ')}:${result.stderr.trim()}`);
  return result;
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
