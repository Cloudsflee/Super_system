import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

// Owner: Runner. Phase: post-P10. The signed envelope remains runner.job-spec.v2.
export function taskContract(task = {}) {
  const argv = Array.isArray(task.argv) ? task.argv : [];
  if (!argv.length || argv.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) || !['node', 'pnpm', 'npm', 'git', 'codex'].includes(argv[0])) fail('runner_command_not_allowed');
  if (!['task', 'candidate'].includes(task.cwd_role || 'task')) fail('runner_path_invalid');
  const deadline = Number(task.deadline_seconds ?? 900);
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 900) fail('runner_deadline_invalid');
  if (!['read', 'write'].includes(task.mode)) fail('execution_mode_invalid');
  for (const list of [task.input_paths || [], task.output_paths || []]) {
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length) fail('runner_path_invalid');
    list.forEach(relativePath);
  }
  return { argv: [...argv], cwd_role: task.cwd_role || 'task', mode: task.mode, input_paths: [...(task.input_paths || [])], output_paths: [...(task.output_paths || [])], runner_profile_ref: task.runner_profile_ref || '', resource_profile: task.resource_profile || 'light', deadline_seconds: deadline, check_ids: [...(task.check_ids || [])], capabilities: [...(task.capabilities || ['network:none'])] };
}

export class RunnerInputProvider {
  constructor({ db, cas }) { this.db = db; this.cas = cas; }
  materialize(spec, root) {
    const refs = spec.input_refs.filter((ref) => ref.type === 'task_contract');
    if (refs.length !== 1) fail('execution_config_missing');
    const ref = refs[0];
    if (ref.ref !== `task-contract:${spec.execution_ref}:${spec.task_ref}:${spec.attempt}`) fail('runner_input_mismatch');
    const receipt = this.db.get("SELECT * FROM receipt_manifests WHERE kind='runner.task-contract' AND cas_sha256=? AND status='verified'", [ref.hash]);
    if (!receipt || sha256Hex(receipt.payload_json) !== receipt.payload_sha256) fail('runner_input_missing');
    const bytes = this.cas.read(ref.hash);
    if (sha256Hex(bytes) !== ref.hash) fail('runner_input_mismatch');
    const contract = taskContract(JSON.parse(bytes.toString('utf8')));
    const mismatches = [];
    if (sha256Hex(canonicalJson(contract)) !== ref.hash) mismatches.push('contract_hash');
    if (contract.mode !== spec.execution_mode) mismatches.push('mode');
    if (canonicalJson(contract.input_paths) !== canonicalJson(spec.input_paths)) mismatches.push('input_paths');
    if (canonicalJson(contract.output_paths) !== canonicalJson(spec.output_paths)) mismatches.push('output_paths');
    if (canonicalJson(contract.check_ids) !== canonicalJson(spec.check_ids)) mismatches.push('check_ids');
    if (contract.resource_profile !== spec.resource_profile) mismatches.push('resource_profile');
    if (contract.runner_profile_ref && contract.runner_profile_ref !== spec.runner_profile_ref) mismatches.push('runner_profile_ref');
    if (mismatches.length) fail('runner_input_mismatch', { mismatches, contract_hash: sha256Hex(canonicalJson(contract)), spec_hash: ref.hash });
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [spec.execution_ref]);
    if (!execution) fail('runner_input_missing');
    for (const input of spec.input_refs.filter((item) => item.type !== 'task_contract')) {
      const pinned = this.db.get('SELECT * FROM execution_inputs WHERE execution_id=? AND input_type=? AND ref_id=? AND ref_revision=? AND ref_hash=?', [execution.id, input.type, input.ref, input.revision, input.hash]);
      if (!pinned) fail('runner_input_missing');
      if (input.type === 'context_pack') {
        const pack = this.db.get("SELECT * FROM context_packs WHERE id=? AND status='sealed' AND pack_hash=?", [input.ref, input.hash]);
        if (!pack) fail('runner_input_missing');
        this.cas.read(pack.payload_cas_hash);
      } else if (!['brief', 'workflow', 'repository'].includes(input.type)) this.cas.read(input.hash);
    }
    treeManifest(root);
    for (const relative of spec.input_paths) {
      const file = containedPath(root, relative);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail('runner_input_missing');
    }
    return { contract, contract_sha256: ref.hash, workspacePath: path.resolve(root) };
  }
}

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\0\r\n:]/.test(value) || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('runner_path_invalid');
  return value;
}
export function containedPath(root, relative) {
  const base = path.resolve(root); relativePath(relative);
  if (fs.lstatSync(base).isSymbolicLink()) fail('runner_path_invalid');
  let file = base;
  for (const part of relative.split('/')) { file = path.join(file, part); if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail('runner_path_invalid'); }
  if (!file.startsWith(`${base}${path.sep}`)) fail('runner_path_invalid');
  return file;
}
export function treeManifest(root) {
  const entries = []; let size = 0;
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('runner_path_invalid');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) { size += stat.size; if (size > 100 * 1024 * 1024 || entries.length >= 10000) fail('runner_output_too_large'); entries.push({ path: relativePath(path.relative(root, file).replaceAll('\\', '/')), sha256: sha256Hex(fs.readFileSync(file)), byte_length: stat.size }); }
      else fail('runner_path_invalid');
    }
  };
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) fail('runner_path_invalid');
  walk(root); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function outputManifest(root, outputPaths) {
  let size = 0;
  const entries = outputPaths.map((relative) => {
    const file = containedPath(root, relative);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail('runner_artifact_missing');
    const stat = fs.lstatSync(file); size += stat.size;
    if (size > 10 * 1024 * 1024) fail('runner_output_too_large');
    const bytes = fs.readFileSync(file); return { path: relative, sha256: sha256Hex(bytes), byte_length: bytes.length };
  });
  return { schema_version: 'runner.output-manifest.v1', entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}
function fail(code, details = {}) { throw new PlatformError(code, 'runner input or output validation failed', details, 422); }
